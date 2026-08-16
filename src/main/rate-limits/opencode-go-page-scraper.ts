import {
  extractEmbeddedObjectAfterKey,
  extractEnclosingEmbeddedObject,
  findEmbeddedTopLevelMatch
} from './opencode-page-object-parser'

const MAX_PAGE_LENGTH = 10_000_000
const REACT_FLIGHT_REFERENCE = '(?:\\$R\\[\\d+\\]\\s*=\\s*)?'
const USAGE_KEY_PATTERNS = {
  rollingUsage: /(?:"rollingUsage"|\brollingUsage\b)\s*:/g,
  weeklyUsage: /(?:"weeklyUsage"|\bweeklyUsage\b)\s*:/g,
  monthlyUsage: /(?:"monthlyUsage"|\bmonthlyUsage\b)\s*:/g
} as const
const USAGE_PERCENT_FIELD = /^(?:"usagePercent"|usagePercent)\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)/
const RESET_SECONDS_FIELD = /^(?:"resetInSec"|resetInSec)\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)/
const USE_BALANCE_CANDIDATE = /(?:"useBalance"|\buseBalance\b)\s*:/g
const USE_BALANCE_FIELD = /^(?:"useBalance"|useBalance)\s*:\s*(!0|!1|true|false)/
const ROLLING_USAGE_FIELD = /^(?:"rollingUsage"|rollingUsage)\s*:/
const WEEKLY_USAGE_FIELD = /^(?:"weeklyUsage"|weeklyUsage)\s*:/

function extractTopLevelNumber(objectText: string, fieldPattern: RegExp): number | null {
  const match = findEmbeddedTopLevelMatch(objectText, fieldPattern)
  const value = match ? Number.parseFloat(match[1]) : Number.NaN
  return Number.isFinite(value) ? value : null
}

function extractUsageBlock(text: string, key: keyof typeof USAGE_KEY_PATTERNS): string | null {
  return extractEmbeddedObjectAfterKey(text, USAGE_KEY_PATTERNS[key], (block) => {
    return (
      extractTopLevelNumber(block, USAGE_PERCENT_FIELD) !== null &&
      extractTopLevelNumber(block, RESET_SECONDS_FIELD) !== null
    )
  })
}

type ParsedSubscription = {
  rollingUsagePercent: number
  weeklyUsagePercent: number
  monthlyUsagePercent: number | null
  rollingResetInSec: number
  weeklyResetInSec: number
  monthlyResetInSec: number | null
  useBalance: boolean | null
}

// The billing server serializes the Zen (pay-as-you-go) balance in units of
// 1e-8 USD (e.g. 2_375_000_000 → $23.75), so scale it back to dollars.
const ZEN_BILLING_SCALE = 100_000_000

const BILLING_BALANCE_CANDIDATE = /(?:"balance"|\bbalance\b)\s*:/g
const BILLING_BALANCE_FIELD = new RegExp(
  `^(?:"balance"|balance)\\s*:\\s*${REACT_FLIGHT_REFERENCE}(-?[0-9]+(?:\\.[0-9]+)?)`
)
const BILLING_RECORD_FIELDS = [
  /^(?:"customerID"|customerID)\s*:/,
  /^(?:"paymentMethodID"|paymentMethodID)\s*:/,
  /^(?:"reload"|reload)\s*:/,
  /^(?:"reloadAmount"|reloadAmount)\s*:/,
  /^(?:"monthlyLimit"|monthlyLimit)\s*:/,
  /^(?:"lite"|lite)\s*:/
]
const CONFIGURED_BILLING_FIELD = new RegExp(
  `^(?:"(?:customerID|paymentMethodID)"|customerID|paymentMethodID)\\s*:\\s*${REACT_FLIGHT_REFERENCE}"[^"]+"`
)

// The balance shares the already-fetched usage payload, so no extra request is needed.
export function parseZenBalanceUsd(text: string): number | null {
  if (!text || text.length > MAX_PAGE_LENGTH) {
    return null
  }
  return parseScaledBillingBalance(text)
}

function parseScaledBillingBalance(text: string): number | null {
  for (const candidate of text.matchAll(BILLING_BALANCE_CANDIDATE)) {
    const block = extractEnclosingEmbeddedObject(text, candidate.index ?? 0)
    if (!block) {
      continue
    }
    const discriminatorCount = BILLING_RECORD_FIELDS.filter((field) =>
      findEmbeddedTopLevelMatch(block, field)
    ).length
    if (discriminatorCount < 2) {
      continue
    }
    const match = findEmbeddedTopLevelMatch(block, BILLING_BALANCE_FIELD)
    const raw = match ? Number.parseFloat(match[1]) : Number.NaN
    if (!Number.isFinite(raw)) {
      continue
    }
    // Why: zero is ubiquitous for unconfigured billing, while granted credit can
    // be positive without a payment customer.
    if (raw <= 0 && !findEmbeddedTopLevelMatch(block, CONFIGURED_BILLING_FIELD)) {
      return null
    }
    return raw / ZEN_BILLING_SCALE
  }
  return null
}

function parseUseBalance(text: string): boolean | null {
  for (const candidate of text.matchAll(USE_BALANCE_CANDIDATE)) {
    const block = extractEnclosingEmbeddedObject(text, candidate.index ?? 0)
    if (
      !block ||
      !findEmbeddedTopLevelMatch(block, ROLLING_USAGE_FIELD) ||
      !findEmbeddedTopLevelMatch(block, WEEKLY_USAGE_FIELD)
    ) {
      continue
    }
    const raw = findEmbeddedTopLevelMatch(block, USE_BALANCE_FIELD)?.[1]
    return raw === '!0' || raw === 'true' ? true : raw === '!1' || raw === 'false' ? false : null
  }
  return null
}

export function parseSubscriptionFromPageText(text: string): ParsedSubscription | null {
  // Why: OpenCode usage is scraped from HTML-embedded JS (React Flight wire
  // format). Defensive size check prevents runaway parsing on unexpected payloads.
  if (!text || text.length > MAX_PAGE_LENGTH) {
    return null
  }

  // Find the first occurrence of each usage key that has both usagePercent and
  // resetInSec as direct numeric fields. This skips null occurrences and
  // billing-context duplicates that use the same key name without usage data.
  const rollingBlock = extractUsageBlock(text, 'rollingUsage')
  const weeklyBlock = extractUsageBlock(text, 'weeklyUsage')
  const monthlyBlock = extractUsageBlock(text, 'monthlyUsage')

  const rollingPercent =
    rollingBlock !== null ? extractTopLevelNumber(rollingBlock, USAGE_PERCENT_FIELD) : null
  const rollingReset =
    rollingBlock !== null ? extractTopLevelNumber(rollingBlock, RESET_SECONDS_FIELD) : null
  const weeklyPercent =
    weeklyBlock !== null ? extractTopLevelNumber(weeklyBlock, USAGE_PERCENT_FIELD) : null
  const weeklyReset =
    weeklyBlock !== null ? extractTopLevelNumber(weeklyBlock, RESET_SECONDS_FIELD) : null

  if (
    rollingPercent === null ||
    rollingReset === null ||
    weeklyPercent === null ||
    weeklyReset === null
  ) {
    return null
  }

  const monthlyPercent =
    monthlyBlock !== null ? extractTopLevelNumber(monthlyBlock, USAGE_PERCENT_FIELD) : null
  const monthlyReset =
    monthlyBlock !== null ? extractTopLevelNumber(monthlyBlock, RESET_SECONDS_FIELD) : null

  return {
    rollingUsagePercent: Math.min(100, Math.max(0, rollingPercent)),
    weeklyUsagePercent: Math.min(100, Math.max(0, weeklyPercent)),
    monthlyUsagePercent:
      monthlyPercent !== null ? Math.min(100, Math.max(0, monthlyPercent)) : null,
    rollingResetInSec: rollingReset,
    weeklyResetInSec: weeklyReset,
    monthlyResetInSec: monthlyReset,
    useBalance: parseUseBalance(text)
  }
}
