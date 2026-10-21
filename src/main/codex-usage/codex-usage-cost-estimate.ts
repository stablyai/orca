import { MODEL_PRICING, normalizeModelForPricing } from './codex-model-pricing'

/** Token counts to price. The long-context fields are the subset of each total that came from
 *  requests whose prompt exceeded the long-context threshold. */
export type CodexBillableTokens = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  longContextInputTokens: number
  longContextCachedInputTokens: number
  longContextOutputTokens: number
}

function priceTokens(
  rates: { input: number; cachedInput: number; output: number },
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): number {
  const clampedCached = Math.min(Math.max(cachedInputTokens, 0), Math.max(inputTokens, 0))
  // Why: Codex cached tokens are part of the input bucket. Charge uncached
  // input on (input-cached) so cached tokens are not billed once at full input
  // price and again at cache-read price.
  const nonCachedInputTokens = Math.max(inputTokens - clampedCached, 0)
  return (
    nonCachedInputTokens * rates.input +
    clampedCached * rates.cachedInput +
    Math.max(outputTokens, 0) * rates.output
  )
}

export function estimateCostUsd(model: string | null, tokens: CodexBillableTokens): number | null {
  const normalized = normalizeModelForPricing(model)
  if (!normalized) {
    return null
  }
  const pricing = MODEL_PRICING[normalized]
  if (!pricing.longContext) {
    return (
      priceTokens(pricing, tokens.inputTokens, tokens.cachedInputTokens, tokens.outputTokens) /
      1_000_000
    )
  }
  const longInput = Math.min(tokens.longContextInputTokens, tokens.inputTokens)
  const longCached = Math.min(tokens.longContextCachedInputTokens, tokens.cachedInputTokens)
  const longOutput = Math.min(tokens.longContextOutputTokens, tokens.outputTokens)
  return (
    (priceTokens(
      pricing,
      tokens.inputTokens - longInput,
      tokens.cachedInputTokens - longCached,
      tokens.outputTokens - longOutput
    ) +
      priceTokens(pricing.longContext, longInput, longCached, longOutput)) /
    1_000_000
  )
}
