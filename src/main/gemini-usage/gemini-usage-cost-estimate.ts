import { MODEL_PRICING, normalizeModelForPricing } from './gemini-model-pricing'

export function addCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null
  }
  return (left ?? 0) + (right ?? 0)
}

export function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens = 0
): number | null {
  const normalized = normalizeModelForPricing(model)
  if (!normalized) {
    return null
  }
  const pricing = MODEL_PRICING[normalized]
  const clampedCached = Math.min(cachedInputTokens, inputTokens)
  // Why: Gemini cached tokens are part of the prompt token bucket. Charge uncached
  // input on (input - cached) so cached tokens are billed at cached rate rather than double-billed.
  const nonCachedInputTokens = Math.max(inputTokens - clampedCached, 0)
  // Why: Gemini API bills generated thinking tokens at standard output rates.
  const totalBilledOutputTokens = outputTokens + reasoningOutputTokens

  // Why: Gemini API selects rate tier based on total prompt size (<= 200k vs > 200k).
  const isLongContext =
    pricing.thresholdTokens !== undefined && inputTokens > pricing.thresholdTokens
  const inputRate =
    isLongContext && pricing.inputAboveThreshold !== undefined
      ? pricing.inputAboveThreshold
      : pricing.input
  const cachedRate =
    isLongContext && pricing.cachedInputAboveThreshold !== undefined
      ? pricing.cachedInputAboveThreshold
      : pricing.cachedInput
  const outputRate =
    isLongContext && pricing.outputAboveThreshold !== undefined
      ? pricing.outputAboveThreshold
      : pricing.output

  return (
    (nonCachedInputTokens * inputRate +
      clampedCached * cachedRate +
      totalBilledOutputTokens * outputRate) /
    1_000_000
  )
}
