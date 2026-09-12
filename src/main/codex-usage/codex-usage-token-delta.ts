import { ensureNumber } from '../usage/usage-record-coercion'

export type CodexUsageRawUsage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

type CodexUsageDeltaResolution =
  | { kind: 'event'; delta: CodexUsageRawUsage; nextTotals: CodexUsageRawUsage | null }
  | { kind: 'baseline'; nextTotals: CodexUsageRawUsage }

export function normalizeRawUsage(value: unknown): CodexUsageRawUsage | null {
  if (value == null || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const inputTokens = ensureNumber(record.input_tokens)
  const cachedInputTokens = ensureNumber(
    record.cached_input_tokens ?? record.cache_read_input_tokens
  )
  const outputTokens = ensureNumber(record.output_tokens)
  const reasoningOutputTokens = ensureNumber(record.reasoning_output_tokens)
  const totalTokens = ensureNumber(record.total_tokens)

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    // Why: legacy Codex logs can omit total_tokens. Reasoning is already billed
    // inside output, so synthesizing input+output matches Codex pricing instead
    // of double-counting reasoning as another billable bucket.
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens
  }
}

function subtractRawUsage(
  current: CodexUsageRawUsage,
  previous: CodexUsageRawUsage | null
): CodexUsageRawUsage {
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

function addRawUsage(left: CodexUsageRawUsage, right: CodexUsageRawUsage): CodexUsageRawUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  }
}

function rawUsageEquals(left: CodexUsageRawUsage, right: CodexUsageRawUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens
  )
}

function rawUsageIsMonotonic(current: CodexUsageRawUsage, previous: CodexUsageRawUsage): boolean {
  return (
    current.inputTokens >= previous.inputTokens &&
    current.cachedInputTokens >= previous.cachedInputTokens &&
    current.outputTokens >= previous.outputTokens &&
    current.reasoningOutputTokens >= previous.reasoningOutputTokens
  )
}

function rawUsageMagnitude(usage: CodexUsageRawUsage): number {
  return (
    usage.inputTokens + usage.cachedInputTokens + usage.outputTokens + usage.reasoningOutputTokens
  )
}

function looksLikeStaleRegression(
  current: CodexUsageRawUsage,
  previous: CodexUsageRawUsage,
  last: CodexUsageRawUsage
): boolean {
  const previousTotal = rawUsageMagnitude(previous)
  const currentTotal = rawUsageMagnitude(current)
  const lastTotal = rawUsageMagnitude(last)
  if (previousTotal <= 0 || currentTotal <= 0 || lastTotal <= 0) {
    return false
  }
  return currentTotal * 100 >= previousTotal * 98 || currentTotal + lastTotal * 2 >= previousTotal
}

export function resolveCodexUsageDelta(
  totalUsage: CodexUsageRawUsage | null,
  lastUsage: CodexUsageRawUsage | null,
  previousTotals: CodexUsageRawUsage | null
): CodexUsageDeltaResolution | null {
  if (totalUsage && lastUsage && previousTotals) {
    if (rawUsageEquals(totalUsage, previousTotals)) {
      return null
    }
    if (
      !rawUsageIsMonotonic(totalUsage, previousTotals) &&
      looksLikeStaleRegression(totalUsage, previousTotals, lastUsage)
    ) {
      return null
    }
    // Why: Codex totals are mutable snapshots after compaction/resume. The
    // last_token_usage payload is the billable increment; totals are the baseline.
    return { kind: 'event', delta: lastUsage, nextTotals: totalUsage }
  }

  if (totalUsage && lastUsage) {
    return { kind: 'event', delta: lastUsage, nextTotals: totalUsage }
  }

  if (totalUsage && previousTotals) {
    if (rawUsageEquals(totalUsage, previousTotals)) {
      return null
    }
    if (!rawUsageIsMonotonic(totalUsage, previousTotals)) {
      return { kind: 'baseline', nextTotals: totalUsage }
    }
    return {
      kind: 'event',
      delta: subtractRawUsage(totalUsage, previousTotals),
      nextTotals: totalUsage
    }
  }

  if (totalUsage) {
    return { kind: 'event', delta: totalUsage, nextTotals: totalUsage }
  }

  if (lastUsage && previousTotals) {
    return { kind: 'event', delta: lastUsage, nextTotals: addRawUsage(previousTotals, lastUsage) }
  }

  if (lastUsage) {
    return { kind: 'event', delta: lastUsage, nextTotals: null }
  }

  return null
}

export function buildCodexUsageEventKey(
  rootThreadId: string | null | undefined,
  totalUsage: CodexUsageRawUsage | null,
  lastUsage: CodexUsageRawUsage | null
): string {
  // Why: fork/resume rollouts copy token_count records into new files, but Codex
  // rewrites copied record timestamps to the fork creation time while preserving
  // monotonic token usage snapshots and deltas. Key on root thread identity and
  // token usage tuples so copied history dedupes across forks even when timestamps
  // are rewritten (#19139), while preventing collisions between unrelated sessions.
  const tupleOf = (usage: CodexUsageRawUsage | null): string =>
    usage
      ? [
          usage.inputTokens,
          usage.cachedInputTokens,
          usage.outputTokens,
          usage.reasoningOutputTokens,
          usage.totalTokens
        ].join(',')
      : ''
  return [rootThreadId ?? '', tupleOf(totalUsage), tupleOf(lastUsage)].join('|')
}
