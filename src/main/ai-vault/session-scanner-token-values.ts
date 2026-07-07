import type { CodexUsageSnapshot } from './session-scanner-types'
import { asRecord } from './session-scanner-values'

export function tokenTotal(value: unknown): number {
  const usage = asRecord(value)
  if (!usage) {
    return 0
  }
  const explicitTotal =
    numberValue(usage.total) || numberValue(usage.totalTokens) || numberValue(usage.total_tokens)
  if (explicitTotal > 0) {
    return explicitTotal
  }

  const fields: unknown[] = [
    usage.input,
    usage.inputTokens,
    usage.input_tokens,
    usage.output,
    usage.outputTokens,
    usage.output_tokens,
    usage.cacheRead,
    usage.cacheReadTokens,
    usage.cache_read_input_tokens,
    usage.cacheWrite,
    usage.cacheWriteTokens,
    usage.cache_creation_input_tokens,
    usage.cached,
    usage.cachedInputTokens,
    usage.cached_input_tokens,
    usage.reasoning,
    usage.reasoningOutputTokens,
    usage.reasoning_output_tokens
  ]
  return fields.reduce<number>((total, current) => total + numberValue(current), 0)
}

export function copilotModelMetricsTotal(value: unknown): number {
  const metrics = asRecord(value)
  if (!metrics) {
    return 0
  }
  let total = 0
  for (const metric of Object.values(metrics)) {
    const record = asRecord(metric)
    const usage = asRecord(record?.usage)
    if (!usage) {
      continue
    }
    total += tokenTotal(usage)
  }
  return total
}

export function claudeUsageTotal(value: unknown): number {
  const usage = asRecord(value)
  if (!usage) {
    return 0
  }
  return (
    numberValue(usage.input_tokens) +
    numberValue(usage.output_tokens) +
    numberValue(usage.cache_read_input_tokens) +
    numberValue(usage.cache_creation_input_tokens)
  )
}

export function normalizeCodexUsage(value: unknown): CodexUsageSnapshot | null {
  const usage = asRecord(value)
  if (!usage) {
    return null
  }
  const inputTokens = numberValue(usage.input_tokens)
  const cachedInputTokens = numberValue(usage.cached_input_tokens ?? usage.cache_read_input_tokens)
  const outputTokens = numberValue(usage.output_tokens)
  const reasoningOutputTokens = numberValue(usage.reasoning_output_tokens)
  const totalTokens = numberValue(usage.total_tokens)

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens
  }
}

export function subtractCodexUsage(
  current: CodexUsageSnapshot,
  previous: CodexUsageSnapshot | null
): CodexUsageSnapshot {
  return {
    inputTokens: Math.max(current.inputTokens - (previous?.inputTokens ?? 0), 0),
    cachedInputTokens: Math.max(current.cachedInputTokens - (previous?.cachedInputTokens ?? 0), 0),
    outputTokens: Math.max(current.outputTokens - (previous?.outputTokens ?? 0), 0),
    reasoningOutputTokens: Math.max(
      current.reasoningOutputTokens - (previous?.reasoningOutputTokens ?? 0),
      0
    ),
    totalTokens: Math.max(current.totalTokens - (previous?.totalTokens ?? 0), 0)
  }
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function addCodexUsage(
  base: CodexUsageSnapshot,
  increment: CodexUsageSnapshot
): CodexUsageSnapshot {
  return {
    inputTokens: base.inputTokens + increment.inputTokens,
    cachedInputTokens: base.cachedInputTokens + increment.cachedInputTokens,
    outputTokens: base.outputTokens + increment.outputTokens,
    reasoningOutputTokens: base.reasoningOutputTokens + increment.reasoningOutputTokens,
    totalTokens: base.totalTokens + increment.totalTokens
  }
}
