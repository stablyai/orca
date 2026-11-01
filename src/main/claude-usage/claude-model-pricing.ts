import {
  addTokenTotals,
  minTokenTotals,
  NO_TOKENS,
  type ClaudeBillableTokens
} from './claude-billable-tokens'
import type { ClaudeUsageTokenTotals } from './types'

type ClaudeTokenRates = {
  input: number
  output: number
  cacheRead: number
  /** 5-minute TTL cache-write rate. */
  cacheWrite: number
  cacheWrite1h: number
}

type ClaudeModelPricing = ClaudeTokenRates & {
  /** Applies to whole requests; bump CLAUDE_USAGE_PROJECTION_VERSION when tiers change. */
  longContext?: ClaudeTokenRates & { thresholdTokens: number }
}

const SONNET_4_LONG_CONTEXT = {
  thresholdTokens: 200_000,
  input: 6,
  output: 22.5,
  cacheRead: 0.6,
  cacheWrite: 7.5,
  cacheWrite1h: 12
}

// Mythos models are billed at their Fable counterparts' rates.
const FABLE_5_1_PRICING: ClaudeModelPricing = {
  input: 10,
  output: 50,
  cacheRead: 0.25,
  cacheWrite: 12.5,
  cacheWrite1h: 20
}
const FABLE_5_PRICING: ClaudeModelPricing = {
  input: 10,
  output: 50,
  cacheRead: 1,
  cacheWrite: 12.5,
  cacheWrite1h: 20
}

// Unknown model versions stay unpriced until explicitly added.
export const MODEL_PRICING: Record<string, ClaudeModelPricing> = {
  'claude-fable-5-1': FABLE_5_1_PRICING,
  'claude-mythos-5-1': FABLE_5_1_PRICING,
  'claude-fable-5': FABLE_5_PRICING,
  'claude-mythos-5': FABLE_5_PRICING,
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  // Sonnet 5 has no long-context premium or scheduled increase from its $2/$10 rates.
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  // Sonnet 4.6 keeps standard rates across its full 1M context window.
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6
  },
  'claude-sonnet-4-5': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    longContext: SONNET_4_LONG_CONTEXT
  },
  'claude-sonnet-4': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    longContext: SONNET_4_LONG_CONTEXT
  },
  'claude-sonnet-3-7': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-sonnet-3-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    cacheWrite1h: 0.2,
    longContext: {
      thresholdTokens: 100_000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite: 0.625,
      cacheWrite1h: 1
    }
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1, cacheWrite1h: 1.6 },
  'claude-haiku-3': {
    input: 0.25,
    output: 1.25,
    cacheRead: 0.03,
    cacheWrite: 0.3,
    cacheWrite1h: 0.5
  }
}

// These opaque IDs have no parsable model version.
const MODEL_ALIASES: Record<string, string> = {
  model_placeholder_m26: 'claude-opus-4-6',
  model_placeholder_m35: 'claude-sonnet-4-6'
}

const MODEL_FAMILIES = 'fable|mythos|opus|sonnet|haiku'
// Exclude date stamps and context suffixes such as -1m from minor-version matches.
const FAMILY_FIRST_ID = new RegExp(
  `(?:^|[^a-z])(?<family>${MODEL_FAMILIES})-(?<major>\\d{1,2})(?:-(?<minor>\\d{1,2})(?![0-9a-z]))?(?![0-9])`
)
// Retain legacy version-first IDs from historical logs, such as claude-3-5-sonnet-20241022.
const VERSION_FIRST_ID = new RegExp(
  `(?:^|[^0-9a-z])(?<major>\\d{1,2})(?:-(?<minor>\\d{1,2}))?-(?<family>${MODEL_FAMILIES})(?![a-z])`
)

function parseModelKey(normalized: string): string | null {
  const groups = (FAMILY_FIRST_ID.exec(normalized) ?? VERSION_FIRST_ID.exec(normalized))?.groups
  if (!groups) {
    return null
  }
  const { family, major, minor } = groups
  return minor === undefined ? `claude-${family}-${major}` : `claude-${family}-${major}-${minor}`
}

export function normalizeModelForPricing(model: string | null): string | null {
  if (!model) {
    return null
  }
  const lower = model.toLowerCase().trim()
  const key = MODEL_ALIASES[lower] ?? parseModelKey(lower.replace(/\./g, '-'))
  return key !== null && Object.hasOwn(MODEL_PRICING, key) ? key : null
}

const longContextThresholdByModel = new Map<string, number | null>()

function longContextThresholdTokens(model: string | null): number | null {
  if (model === null) {
    return null
  }
  let threshold = longContextThresholdByModel.get(model)
  if (threshold === undefined) {
    const key = normalizeModelForPricing(model)
    threshold = key === null ? null : (MODEL_PRICING[key].longContext?.thresholdTokens ?? null)
    longContextThresholdByModel.set(model, threshold)
  }
  return threshold
}

function priceTokens(rates: ClaudeTokenRates, tokens: ClaudeUsageTokenTotals): number {
  const write1hTokens = Math.min(Math.max(tokens.cacheWrite1hTokens, 0), tokens.cacheWriteTokens)
  return (
    tokens.inputTokens * rates.input +
    tokens.outputTokens * rates.output +
    tokens.cacheReadTokens * rates.cacheRead +
    (tokens.cacheWriteTokens - write1hTokens) * rates.cacheWrite +
    write1hTokens * rates.cacheWrite1h
  )
}

export function longContextTurnTokens(
  model: string | null,
  turn: ClaudeUsageTokenTotals
): ClaudeUsageTokenTotals | undefined {
  const threshold = longContextThresholdTokens(model)
  const prompt = turn.inputTokens + turn.cacheReadTokens + turn.cacheWriteTokens
  return threshold !== null && prompt > threshold ? addTokenTotals(NO_TOKENS, turn) : undefined
}

export function estimateCostUsd(model: string | null, tokens: ClaudeBillableTokens): number | null {
  const normalized = normalizeModelForPricing(model)
  if (!normalized) {
    return null
  }
  const pricing = MODEL_PRICING[normalized]
  if (!pricing.longContext || !tokens.longContext) {
    return priceTokens(pricing, tokens) / 1_000_000
  }
  const longTokens = minTokenTotals(tokens.longContext, tokens)
  return (
    (priceTokens(pricing, addTokenTotals(tokens, longTokens, -1)) +
      priceTokens(pricing.longContext, longTokens)) /
    1_000_000
  )
}
