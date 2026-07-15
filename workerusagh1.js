require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function getOriginConfig(origin) {
  const map = {
    US: {
      currency: "USD",
      countryName: "United States",
      countrySearch: "united states",
      countryCode2: "US",
      countryCode3: "USA",
      sendingParam: "US",
      localePath: "en-us",
    },
    GB: {
      currency: "GBP",
      countryName: "United Kingdom",
      countrySearch: "united kingdom",
      countryCode2: "GB",
      countryCode3: "GBR",
      sendingParam: "GB",
      localePath: "en-gb",
    },
  };

  return map[origin] || map.US;
}

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "GHS";
}

function destinationCountryName(destination) {
  if (destination === "GH") return "Ghana";
  if (destination === "NG") return "Nigeria";
  return "Ghana";
}

function destinationSearch(destination) {
  if (destination === "GH") return "gh";
  if (destination === "NG") return "ng";
  return "gh";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText(provider, text) {
  const safe = provider
    .replace(/\s+/g, "-")
    .toLowerCase();

  const file = `debug-${safe}.txt`;

  fs.writeFileSync(
    file,
    String(text || ""),
    "utf8"
  );

  return file;
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function extractRateFromText(text, fromCurrency, toCurrency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*1\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Today[’']s rate:\\s*1(?:\\.00)?\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`rate:?\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${toCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 10000) {
        return value;
      }
    }
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "USD") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
    new RegExp(`Fee:?\\s*([0-9.]+)`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Receive amount\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function buildPayloadFromText(source, bodyText) {
  const originCfg = getOriginConfig(source.origin);
  const fromCurrency = originCfg.currency;
  const toCurrency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, fromCurrency, toCurrency);
  const fee = extractFeeFromText(bodyText, fromCurrency);
  let amountReceived = extractAmountReceivedFromText(bodyText, toCurrency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function buildResult(source, rate, fee = 0, amountReceived = null, extra = {}) {
  const sendAmount = Number(source.send_amount || 1);
  const normalizedAmountReceived =
    amountReceived !== null && amountReceived !== undefined
      ? Number(Number(amountReceived).toFixed(6))
      : Number(Number(rate).toFixed(6));

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: Number(Number(rate).toFixed(6)),
    fee: Number(Number(fee || 0).toFixed(6)),
    amount_received: normalizedAmountReceived,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}

async function selectCountryFromSearch(page, searchText, visibleTextRegex) {
  const searchBoxes = page.getByRole("searchbox", { name: /Search/i });
  const count = await searchBoxes.count();
  if (count) {
    await searchBoxes.last().fill(searchText);
    await page.waitForTimeout(1000);
    await page.getByRole("option", { name: visibleTextRegex }).click().catch(async () => {
      await page.getByText(visibleTextRegex).first().click().catch(async () => {
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
      });
    });
    return;
  }

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
}

function extractUsdGhsRate(text) {
  if (!text) return null;

  const cleaned = String(text)
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const patterns = [
    /Rate\s*1(?:\.00)?\s*USD\s*[=≈]\s*([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
    /1(?:\.00)?\s*USD\s*[=≈]\s*([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
    /USD\s*[=≈]\s*([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
    /Exchange\s*rate[^0-9]*1\s*USD\s*[=≈]\s*([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);

    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);

    if (
      candidate &&
      candidate >= 8 &&
      candidate <= 20
    ) {
      return Number(candidate.toFixed(6));
    }
  }

  return null;
}

async function handleLemFi(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto(`https://lemfi.com/${originCfg.localePath}/`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Accept all cookies/i }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /Accept all/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1500);

  await page.locator("div").filter({ hasText: /^[A-Z]{3}$/ }).first().click({ force: true }).catch(() => {});

  let searchInput = page.getByPlaceholder("Enter currency or country").last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill(originCfg.currency.toLowerCase());
  await page.waitForTimeout(1000);
  await page.getByText(new RegExp(originCfg.countryName, "i")).first().click().catch(async () => {
    await page.getByText(new RegExp(originCfg.currency, "i")).first().click();
  });

  await page.waitForTimeout(1500);

  const codeSelectors = page.locator("div").filter({ hasText: /^[A-Z]{3}$/ });
  const codeCount = await codeSelectors.count();
  if (codeCount >= 2) {
    await codeSelectors.nth(1).click({ force: true }).catch(() => {});
  }

  searchInput = page.getByPlaceholder("Enter currency or country").last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill("ghan");
  await page.waitForTimeout(1000);
  await page.getByText(/GHS|Ghan/i).first().click().catch(() => {});

  await page.waitForTimeout(1500);

  const sendBox = page.getByRole("textbox", { name: /You send/i });
  await sendBox.waitFor({ timeout: 10000 });
  await sendBox.click({ force: true });
  await sendBox.press("Control+A").catch(() => {});
  await sendBox.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract LemFi rate. Screenshot: ${file}`);
  }

  return payload;
}

async function handleSendwave(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto(`https://www.sendwave.com/${originCfg.localePath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  const sendInput = page.getByRole("textbox", { name: "exchange-calculator-send-" });
  await sendInput.waitFor({ timeout: 10000 });

  await page
    .getByTestId("exchange-calculator-send-country-select")
    .getByTestId("ExpandMoreRoundedIcon")
    .click();

  await page.getByRole("combobox", { name: "Search" }).fill(originCfg.countrySearch);
  await page.getByText(new RegExp(`${originCfg.countryName}.*${originCfg.currency}`, "i")).click().catch(async () => {
    await page.getByText(new RegExp(originCfg.countryName, "i")).first().click();
  });

  await page.waitForTimeout(1000);

  await page.getByTestId("exchange-calculator-receive-country-select").click();
  await page.getByRole("combobox", { name: "Search" }).fill("ghana");
  await page.locator("div").filter({ hasText: /^GhanaGHS$/ }).click().catch(async () => {
    await page.getByText(/Ghana/i).first().click();
  });

  await page.waitForTimeout(1000);

  await sendInput.click();
  await sendInput.fill("1");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Sendwave rate. Screenshot: ${file}`);
  }
  return payload;
}

async function handleTapTap(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://www.taptapsend.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  await page.getByRole("button", { name: "Close Cookie Popup" }).click({ timeout: 10000 }).catch(() => {});
  await page.locator("#destination-currency").selectOption("GH-GHS-DESTINATION").catch(() => {});
  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /USD\s*1\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*USD\s*=\s*([0-9.]+)\s*GHS/i,
    /USD\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, "GHS");
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TapTap Send rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}


async function handlePayAngel(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://payangel.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Close dialogue/i }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /^Close$/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});

  await page.getByRole("link", { name: /Check today’s rate/i }).click();
  await page.waitForTimeout(2000);

  await page.getByRole("button", { name: /USD|GBP/i }).first().click().catch(() => {});
  await page.getByText(new RegExp(`^${originCfg.currency}$`, "i")).click().catch(async () => {
    await page.getByRole("option", { name: new RegExp(`^${originCfg.currency}$`, "i") }).click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  const sendInput = page.getByRole("spinbutton", { name: /You send/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("1");

  await page.locator(".rc-body").click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = extractRateFromText(bodyText, originCfg.currency, "GHS");

  if (!rate) {
    const patterns = [
      /([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
      new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
      new RegExp(`${originCfg.currency}\\s*1\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1]);
      if (candidate && candidate > 0 && candidate < 10000) {
        rate = candidate;
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract PayAngel rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}


async function handleNala(page, source) {
  await page.goto("https://www.nala.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  await page
    .getByRole("button", { name: /Accept/i })
    .click({ timeout: 4000 })
    .catch(() => {});

  await page.keyboard.press("Escape").catch(() => {});

  const currencyButtons = page.getByRole(
    "button",
    { name: "Select currency" }
  );

  await currencyButtons.first().waitFor({
    state: "visible",
    timeout: 20000,
  });

  await currencyButtons.first().click({
    force: true,
    timeout: 15000,
  });

  await page
    .locator("#currency-listbox-dropdown-1")
    .getByText("USD", { exact: true })
    .click({
      force: true,
      timeout: 15000,
    })
    .catch(async () => {
      await page
        .getByRole("option", {
          name: /United States Dollar USD/i,
        })
        .click({
          force: true,
          timeout: 15000,
        });
    });

  await page.waitForTimeout(1200);

  await currencyButtons.nth(1).click({
    force: true,
    timeout: 15000,
  });

  await page
    .getByRole("option", {
      name: /Ghanaian Cedi GHS/i,
    })
    .click({
      force: true,
      timeout: 15000,
    });

  await page.waitForTimeout(5000);

  const directRateText = await page
    .getByText(
      /USD\s*≈\s*[0-9.]+\s*GHS/i
    )
    .first()
    .innerText()
    .catch(() => "");

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const combinedText =
    `${directRateText}\n${bodyText}`;

  saveDebugText(
    source.provider,
    combinedText
  );

  const rate = extractUsdGhsRate(
    combinedText
  );

  if (!rate) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `Could not extract Nala rate. ` +
      `Captured text: ${combinedText
        .replace(/\s+/g, " ")
        .slice(0, 350)}. ` +
      `Screenshot: ${file}`
    );
  }

  return buildResult(
    source,
    rate,
    0,
    rate,
    {
      verified_method:
        "nala_visible_rate_text",
    }
  );
}

async function handleInstarem(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://www.instarem.com/en-us/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator(".widget-calculator__dropdown-main-right").first().click();

  const searchBox1 = page.getByRole("textbox", {
    name: /Search country or currency/i,
  });
  await searchBox1.waitFor({ timeout: 10000 });
  await searchBox1.click();
  await searchBox1.fill("USD");
  await page.locator("#qodef-page-content").getByText("United States of America").click().catch(async () => {
    await page.getByText(/United States of America|United States|USD/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  await page.locator(".widget-calculator__recive > .widget-calculator__dropdown > .widget-calculator__dropdown-main > .widget-calculator__dropdown-main-right").click();

  const searchBox2 = page.getByRole("textbox", {
    name: /Search country or currency/i,
  });
  await searchBox2.click();
  await searchBox2.fill("GH");
  await page.getByText("Ghana GHS").click().catch(async () => {
    await page.getByText(/Ghana GHS|Ghana/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /([0-9.]+)\s*GHS/i,
    /1\s*USD\s*=\s*([0-9.]+)\s*GHS/i,
    /USD\s*1\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, "GHS");
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Instarem rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleJupay(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://jupay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#country").first().selectOption(originCfg.currency).catch(() => {});
  await page.waitForTimeout(1500);

  const scrapeAmount = 100;

  const sendInput = page.getByRole("textbox", { name: /You send/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click();
  await sendInput.fill(String(scrapeAmount));

  await page.locator("div").filter({ hasText: /Simple Fast Money Transfer/i }).nth(2).click().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});

  await page.waitForTimeout(6000);

  const receiveInput = page.getByRole("textbox", { name: /Recipient gets/i });

  let amountReceivedTotal = null;
  if (await receiveInput.count()) {
    const rawReceive = await receiveInput.inputValue().catch(() => "");
    amountReceivedTotal = parseLocaleNumber(rawReceive);
  }

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  if (amountReceivedTotal && scrapeAmount > 0) {
    rate = Number((amountReceivedTotal / scrapeAmount).toFixed(6));
  }

  if (!rate) {
    const patterns = [
      /Exchange Rate:\s*([0-9.]+)\s*Fees:/i,
      new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
      new RegExp(`${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
      /\b([1-9]\d{0,3}\.\d{2,5})\b/,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1] || match[0]);
      if (candidate && candidate > 0) {
        rate = Number(candidate.toFixed(6));
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Jupay rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    send_amount: 1,
    quoted_send_amount: scrapeAmount,
    quoted_amount_received: amountReceivedTotal,
  });
}

async function handleOaPay(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://www.oapay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  // Sending currency = USD
  await page.getByText("GBP").nth(1).click().catch(async () => {
    await page.getByText(/GBP|USD/i).nth(1).click().catch(() => {});
  });
  await page.getByText("USD United States of America").click().catch(async () => {
    await page.getByText(/USD United States of America|USD/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  // Receiving currency = GHS
  await page.getByText("GHS").nth(2).click().catch(async () => {
    await page.getByText(/GHS/i).nth(2).click().catch(() => {});
  });
  await page.getByText("GHS Ghana").click().catch(async () => {
    await page.getByText(/GHS Ghana|GHS/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  // Use the exact working field from your latest recording
  const receiveBox = page.getByRole("textbox", { name: "Recipient Receives" });
  await receiveBox.waitFor({ timeout: 15000 });
  await receiveBox.click({ force: true });
  await receiveBox.press("Control+A").catch(() => {});
  await receiveBox.fill("100.00");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /USD\s*=\s*([0-9.]+)\s*GHS\s*\(no charges\)/i,
    /1\.00\s*USD\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*USD\s*=\s*([0-9.]+)\s*GHS/i,
    /USD\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, "GHS");
  }

  if (!rate) {
    const looseMatches = bodyText.match(/\b([1-9]\d{0,3}\.\d{2,5})\b/g) || [];
    const candidates = looseMatches
      .map((v) => parseFloat(v))
      .filter((v) => !Number.isNaN(v) && v > 0 && v < 10000);

    if (candidates.length) {
      rate = Number(candidates[0].toFixed(6));
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract OaPay rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}


async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "LemFi") payload = await handleLemFi(page, source);
    else if (source.provider === "Sendwave") payload = await handleSendwave(page, source);
    else if (source.provider === "TapTap Send") payload = await handleTapTap(page, source);
    else if (source.provider === "PayAngel") payload = await handlePayAngel(page, source);
    else if (source.provider === "Nala") payload = await handleNala(page, source);
    else if (source.provider === "Instarem") payload = await handleInstarem(page, source);
    else if (source.provider === "Jupay") payload = await handleJupay(page, source);
    else if (source.provider === "OaPay") payload = await handleOaPay(page, source);
    
    else throw new Error(`No handler configured for ${source.provider}`);

    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}
async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-us-gh1.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});