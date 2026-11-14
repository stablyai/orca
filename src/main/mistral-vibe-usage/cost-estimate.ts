import type { VibeModelPricing } from './model-pricing'

export type VibeBillableTokens = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export function estimateVibeCostUsd(
  model: string | null,
  tokens: VibeBillableTokens,
  pricing: ReadonlyMap<string, VibeModelPricing>
): number | null {
  const rates = model ? pricing.get(model) : undefined
  if (!rates) {
    return null
  }
  const cachedInputTokens = Math.min(
    Math.max(tokens.cachedInputTokens, 0),
    Math.max(tokens.inputTokens, 0)
  )
  // Cached tokens are included in input; subtract them to avoid charging both rates.
  const nonCachedInputTokens = Math.max(tokens.inputTokens - cachedInputTokens, 0)
  return (
    (nonCachedInputTokens * rates.input +
      cachedInputTokens * rates.cachedInput +
      Math.max(tokens.outputTokens, 0) * rates.output) /
    1_000_000
  )
}
