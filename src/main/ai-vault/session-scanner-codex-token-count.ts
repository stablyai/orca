import type { CodexUsageSnapshot, SessionAccumulator } from './session-scanner-types'
import {
  addCodexUsage,
  asRecord,
  extractModel,
  normalizeCodexUsage,
  subtractCodexUsage
} from './session-scanner-values'

/**
 * Folds one Codex `token_count` event into the accumulator and returns the
 * running totals to carry forward: the event reports cumulative usage, so only
 * the delta against the previous snapshot may be added.
 */
export function consumeCodexTokenCount(
  accumulator: SessionAccumulator,
  payload: Record<string, unknown>,
  previousTotals: CodexUsageSnapshot | null
): CodexUsageSnapshot | null {
  const info = asRecord(payload.info)
  if (!info) {
    return previousTotals
  }
  const totalUsage = normalizeCodexUsage(info.total_token_usage)
  const lastUsage = normalizeCodexUsage(info.last_token_usage)
  let delta: CodexUsageSnapshot | null = null
  let nextTotals = previousTotals
  if (totalUsage) {
    delta = subtractCodexUsage(totalUsage, previousTotals)
    nextTotals = totalUsage
  } else if (lastUsage) {
    delta = lastUsage
    nextTotals = previousTotals ? addCodexUsage(previousTotals, lastUsage) : lastUsage
  }
  if (delta) {
    accumulator.totalTokens += delta.totalTokens
  }
  const model = extractModel(payload)
  if (model) {
    accumulator.model = model
  }
  return nextTotals
}
