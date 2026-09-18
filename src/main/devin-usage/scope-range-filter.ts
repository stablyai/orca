import type { DevinUsageRange, DevinUsageScope } from '../../shared/devin-usage-types'
import type { DevinUsageDailyAggregate, DevinUsageModelBreakdown, DevinUsageSession } from './types'
import { getLocalUsageDay, getUsageRangeCutoff } from '../usage/usage-calendar-range'

export function filterDailyAggregatesByScopeAndRange(
  dailyAggregates: DevinUsageDailyAggregate[],
  scope: DevinUsageScope,
  range: DevinUsageRange
): DevinUsageDailyAggregate[] {
  const cutoff = getUsageRangeCutoff(range)
  return dailyAggregates.filter((row) => {
    if (scope === 'orca' && !row.worktreeId) {
      return false
    }
    if (cutoff && row.day < cutoff) {
      return false
    }
    return true
  })
}

export function filterSessionsByScopeAndRange(
  sessions: DevinUsageSession[],
  scope: DevinUsageScope,
  range: DevinUsageRange
): DevinUsageSession[] {
  const cutoff = getUsageRangeCutoff(range)
  return sessions.filter((session) => {
    // Why: a session mixing Orca and non-Orca cwds stays visible under 'orca'
    // when any of its locations is attributed — the scoped totals then show
    // only the Orca share (same rule the Codex provider applies).
    if (scope === 'orca' && !session.locationBreakdown.some((entry) => entry.worktreeId !== null)) {
      return false
    }
    if (cutoff) {
      const day = getLocalUsageDay(session.lastTimestamp)
      if (!day || day < cutoff) {
        return false
      }
    }
    return true
  })
}

export type ScopedDevinUsageModelRow = DevinUsageModelBreakdown

// Why: under the 'orca' scope a session's per-model rows must count only the
// worktree-attributed share, mirroring the Codex provider's
// getScopedSessionModels.
export function getScopedDevinSessionModels(
  session: DevinUsageSession,
  scope: DevinUsageScope
): ScopedDevinUsageModelRow[] {
  if (scope === 'all' || session.locationModelBreakdown.length === 0) {
    return session.modelBreakdown
  }

  const rows = new Map<string, DevinUsageModelBreakdown>()
  for (const entry of session.locationModelBreakdown) {
    if (entry.worktreeId === null) {
      continue
    }
    const existing = rows.get(entry.modelKey) ?? {
      modelKey: entry.modelKey,
      modelLabel: entry.modelLabel,
      eventCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null
    }
    existing.eventCount += entry.eventCount
    existing.inputTokens += entry.inputTokens
    existing.cachedInputTokens += entry.cachedInputTokens
    existing.outputTokens += entry.outputTokens
    existing.reasoningOutputTokens += entry.reasoningOutputTokens
    existing.totalTokens += entry.totalTokens
    existing.estimatedCostUsd =
      existing.estimatedCostUsd === null && entry.estimatedCostUsd === null
        ? null
        : (existing.estimatedCostUsd ?? 0) + (entry.estimatedCostUsd ?? 0)
    rows.set(entry.modelKey, existing)
  }
  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}

export function getScopedDevinSessionPrimaryModel(
  session: DevinUsageSession,
  scope: DevinUsageScope
): string | null {
  const scopedModels = getScopedDevinSessionModels(session, scope)
  if (scopedModels.length === 0) {
    return session.primaryModel
  }
  if (scopedModels.length === 1) {
    return scopedModels[0]?.modelLabel ?? null
  }
  return 'Mixed models'
}
