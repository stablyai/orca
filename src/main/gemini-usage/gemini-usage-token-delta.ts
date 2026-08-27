import { ensureNumber } from '../usage/usage-record-coercion'

export type GeminiUsageRawUsage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type GeminiUsageDeltaResolution =
  | { kind: 'event'; delta: GeminiUsageRawUsage; nextTotals: GeminiUsageRawUsage | null }
  | { kind: 'baseline'; nextTotals: GeminiUsageRawUsage }

export function normalizeRawUsage(value: unknown): GeminiUsageRawUsage | null {
  if (value == null || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const target =
    typeof record.tokens === 'object' && record.tokens !== null
      ? (record.tokens as Record<string, unknown>)
      : typeof record.usage === 'object' && record.usage !== null
        ? (record.usage as Record<string, unknown>)
        : typeof record.tokenCount === 'object' && record.tokenCount !== null
          ? (record.tokenCount as Record<string, unknown>)
          : record

  const inputTokens = ensureNumber(
    target.inputTokens ??
      target.input_tokens ??
      target.promptTokens ??
      target.prompt_tokens ??
      target.promptTokenCount ??
      target.input
  )
  const cachedInputTokens = ensureNumber(
    target.cachedInputTokens ??
      target.cached_input_tokens ??
      target.cachedTokens ??
      target.cached_tokens ??
      target.cachedContentTokenCount ??
      target.cacheReadTokens ??
      target.cachedInput ??
      target.cached
  )
  const outputTokens = ensureNumber(
    target.outputTokens ??
      target.output_tokens ??
      target.completionTokens ??
      target.completion_tokens ??
      target.candidatesTokenCount ??
      target.output
  )
  const reasoningOutputTokens = ensureNumber(
    target.reasoningOutputTokens ??
      target.reasoning_output_tokens ??
      target.reasoningTokens ??
      target.reasoning_tokens ??
      target.thoughtsTokenCount ??
      target.thoughtsTokens ??
      target.thoughts_tokens ??
      target.reasoning ??
      target.thoughts
  )
  const explicitTotal = ensureNumber(
    target.totalTokens ?? target.total_tokens ?? target.totalTokenCount ?? target.total
  )

  const computedTotal = Math.max(
    explicitTotal,
    inputTokens + outputTokens + reasoningOutputTokens,
    inputTokens,
    outputTokens
  )

  if (
    inputTokens === 0 &&
    cachedInputTokens === 0 &&
    outputTokens === 0 &&
    reasoningOutputTokens === 0 &&
    computedTotal === 0
  ) {
    return null
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: computedTotal
  }
}

export function subtractRawUsage(
  current: GeminiUsageRawUsage,
  previous: GeminiUsageRawUsage | null
): GeminiUsageRawUsage {
  if (!previous) {
    return current
  }
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      current.reasoningOutputTokens - previous.reasoningOutputTokens
    ),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens)
  }
}

export function addRawUsage(
  left: GeminiUsageRawUsage,
  right: GeminiUsageRawUsage
): GeminiUsageRawUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  }
}

export function rawUsageEquals(left: GeminiUsageRawUsage, right: GeminiUsageRawUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens &&
    left.totalTokens === right.totalTokens
  )
}

export function rawUsageIsMonotonic(
  current: GeminiUsageRawUsage,
  previous: GeminiUsageRawUsage
): boolean {
  return (
    current.inputTokens >= previous.inputTokens &&
    current.cachedInputTokens >= previous.cachedInputTokens &&
    current.outputTokens >= previous.outputTokens &&
    current.totalTokens >= previous.totalTokens
  )
}

export function resolveGeminiUsageDelta(
  totalUsage: GeminiUsageRawUsage | null,
  lastUsage: GeminiUsageRawUsage | null,
  previousTotals: GeminiUsageRawUsage | null
): GeminiUsageDeltaResolution | null {
  if (lastUsage) {
    const nextTotals =
      totalUsage ?? (previousTotals ? addRawUsage(previousTotals, lastUsage) : lastUsage)
    return { kind: 'event', delta: lastUsage, nextTotals }
  }

  if (!totalUsage) {
    return null
  }

  if (!previousTotals) {
    return { kind: 'event', delta: totalUsage, nextTotals: totalUsage }
  }

  if (rawUsageEquals(totalUsage, previousTotals)) {
    return null
  }

  if (rawUsageIsMonotonic(totalUsage, previousTotals)) {
    const delta = subtractRawUsage(totalUsage, previousTotals)
    return { kind: 'event', delta, nextTotals: totalUsage }
  }

  return { kind: 'event', delta: totalUsage, nextTotals: totalUsage }
}

export function buildGeminiUsageEventKey(
  timestamp: string,
  totalUsage: GeminiUsageRawUsage | null,
  lastUsage: GeminiUsageRawUsage | null
): string {
  const usage = lastUsage ?? totalUsage
  if (!usage) {
    return timestamp
  }
  return [
    timestamp,
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens
  ].join('::')
}
