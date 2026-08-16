type ClaudeModelPricing = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  thresholdTokens?: number
  inputAboveThreshold?: number
  outputAboveThreshold?: number
  cacheReadAboveThreshold?: number
  cacheWriteAboveThreshold?: number
}

const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000
const SONNET_LONG_CONTEXT_PRICING = {
  thresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
  inputAboveThreshold: 6,
  outputAboveThreshold: 22.5,
  cacheReadAboveThreshold: 0.6,
  cacheWriteAboveThreshold: 7.5
} satisfies Partial<ClaudeModelPricing>

const MODEL_PRICING: Record<string, ClaudeModelPricing> = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Why: Sonnet 5 bills its full 1M window at flat rates, so no long-context tier here.
  // Why: standard rates, not the $2/$10 introductory rate ending 2026-08-31 — no date dimension.
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    ...SONNET_LONG_CONTEXT_PRICING
  },
  'claude-sonnet-4-5': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    ...SONNET_LONG_CONTEXT_PRICING
  },
  'claude-sonnet-4': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    ...SONNET_LONG_CONTEXT_PRICING
  },
  'claude-sonnet-3-7': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-3-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-haiku-3': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 }
}

const MODEL_ALIASES: Record<string, string> = {
  model_placeholder_m26: 'claude-opus-4-6',
  model_placeholder_m35: 'claude-sonnet-4-6',
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-opus-4.8-thinking': 'claude-opus-4-8',
  'claude-opus-4.6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4.6-thinking': 'claude-sonnet-4-6',
  'claude-opus-4-8-thinking': 'claude-opus-4-8',
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6'
}

function hasClaudeModelVersion(model: string, family: string, version: string): boolean {
  const normalized = model.replace(/\./g, '-')
  return new RegExp(`${family}-${version}(?:$|[^0-9])`).test(normalized)
}

function isLegacyBaseOpus4Model(model: string): boolean {
  const normalized = model.replace(/\./g, '-')
  return /opus-4(?:$|-thinking$|-20\d{6}(?:-thinking)?$|@20\d{6}$)/.test(normalized)
}

function normalizeModelForPricing(model: string | null): string | null {
  if (!model) {
    return null
  }
  const lower = model
    .toLowerCase()
    .trim()
    .replace(/^anthropic[/:]/, '')
  const alias = MODEL_ALIASES[lower]
  if (alias) {
    return alias
  }
  if (hasClaudeModelVersion(lower, 'fable', '5')) {
    return 'claude-fable-5'
  }
  if (hasClaudeModelVersion(lower, 'opus', '5')) {
    return 'claude-opus-5'
  }
  if (hasClaudeModelVersion(lower, 'opus', '4-8')) {
    return 'claude-opus-4-8'
  }
  if (hasClaudeModelVersion(lower, 'opus', '4-7')) {
    return 'claude-opus-4-7'
  }
  if (hasClaudeModelVersion(lower, 'opus', '4-6')) {
    return 'claude-opus-4-6'
  }
  if (hasClaudeModelVersion(lower, 'opus', '4-5')) {
    return 'claude-opus-4-5'
  }
  if (hasClaudeModelVersion(lower, 'opus', '4-1')) {
    return 'claude-opus-4-1'
  }
  if (isLegacyBaseOpus4Model(lower)) {
    return 'claude-opus-4'
  }
  if (lower.includes('opus-4')) {
    // Why: new Opus 4 point releases now share the current low Opus pricing;
    // avoid overbilling unknown future Claude Code model IDs as legacy Opus 4.
    return 'claude-opus-4-8'
  }
  if (hasClaudeModelVersion(lower, 'sonnet', '5')) {
    return 'claude-sonnet-5'
  }
  if (hasClaudeModelVersion(lower, 'sonnet', '4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (hasClaudeModelVersion(lower, 'sonnet', '4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (lower.includes('sonnet-4')) {
    return 'claude-sonnet-4-6'
  }
  if (lower.includes('sonnet-3-7') || lower.includes('sonnet-3.7')) {
    return 'claude-sonnet-3-7'
  }
  // Why: legacy version-first IDs like `claude-3-5-sonnet-20241022` are still
  // present in historical Claude Code/SDK logs read off disk. Match them so
  // their cost is not silently dropped from the breakdown.
  if (
    lower.includes('sonnet-3-5') ||
    lower.includes('sonnet-3.5') ||
    lower.includes('3-5-sonnet') ||
    lower.includes('3.5-sonnet')
  ) {
    return 'claude-sonnet-3-5'
  }
  if (lower.includes('haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  if (lower.includes('haiku-3-5') || lower.includes('haiku-3.5')) {
    return 'claude-haiku-3-5'
  }
  if (lower.includes('3-5-haiku') || lower.includes('3.5-haiku')) {
    return 'claude-haiku-3-5'
  }
  if (lower.includes('haiku-3')) {
    return 'claude-haiku-3'
  }
  return null
}

function calculateTieredCost(
  tokens: number,
  basePrice: number,
  abovePrice?: number,
  threshold?: number
): number {
  if (threshold === undefined || abovePrice === undefined) {
    return tokens * basePrice
  }
  const belowTokens = Math.min(tokens, threshold)
  const aboveTokens = Math.max(tokens - threshold, 0)
  return belowTokens * basePrice + aboveTokens * abovePrice
}

export function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): number | null {
  const normalized = normalizeModelForPricing(model)
  if (!normalized) {
    return null
  }
  const pricing = MODEL_PRICING[normalized]
  return (
    (calculateTieredCost(
      inputTokens,
      pricing.input,
      pricing.inputAboveThreshold,
      pricing.thresholdTokens
    ) +
      calculateTieredCost(
        outputTokens,
        pricing.output,
        pricing.outputAboveThreshold,
        pricing.thresholdTokens
      ) +
      calculateTieredCost(
        cacheReadTokens,
        pricing.cacheRead,
        pricing.cacheReadAboveThreshold,
        pricing.thresholdTokens
      ) +
      calculateTieredCost(
        cacheWriteTokens,
        pricing.cacheWrite,
        pricing.cacheWriteAboveThreshold,
        pricing.thresholdTokens
      )) /
    1_000_000
  )
}
