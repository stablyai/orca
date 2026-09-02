import type { CodexUsageRange, CodexUsageScope } from '../../shared/codex-usage-types'
import type { CodexUsagePersistedState } from './types'
import { getLocalUsageDay, getUsageRangeCutoff } from '../usage/usage-calendar-range'

export type ScopedCodexUsageModelRow = {
  modelKey: string
  modelLabel: string
  hasInferredPricing: boolean
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export function getFilteredDaily(
  state: CodexUsagePersistedState,
  scope: CodexUsageScope,
  range: CodexUsageRange
) {
  const cutoff = getUsageRangeCutoff(range)
  return state.dailyAggregates.filter((entry) => {
    if (cutoff && entry.day < cutoff) {
      return false
    }
    if (scope === 'orca' && entry.worktreeId === null) {
      return false
    }
    return true
  })
}

export function getFilteredSessions(
  state: CodexUsagePersistedState,
  scope: CodexUsageScope,
  range: CodexUsageRange
) {
  const cutoff = getUsageRangeCutoff(range)
  return state.sessions.filter((session) => {
    const day = getLocalUsageDay(session.lastTimestamp)
    if (!day) {
      return false
    }
    if (cutoff && day < cutoff) {
      return false
    }
    if (scope === 'orca') {
      return session.locationBreakdown.some((entry) => entry.worktreeId !== null)
    }
    return true
  })
}

export function getScopedSessionModels(
  session: CodexUsagePersistedState['sessions'][number],
  scope: CodexUsageScope
): ScopedCodexUsageModelRow[] {
  if (scope === 'all' || session.locationModelBreakdown.length === 0) {
    return session.modelBreakdown
  }

  const rows = new Map<string, ScopedCodexUsageModelRow>()
  for (const entry of session.locationModelBreakdown) {
    if (entry.worktreeId === null) {
      continue
    }
    const existing = rows.get(entry.modelKey) ?? {
      modelKey: entry.modelKey,
      modelLabel: entry.modelLabel,
      hasInferredPricing: false,
      eventCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0
    }
    existing.hasInferredPricing ||= entry.hasInferredPricing
    existing.eventCount += entry.eventCount
    existing.inputTokens += entry.inputTokens
    existing.cachedInputTokens += entry.cachedInputTokens
    existing.outputTokens += entry.outputTokens
    existing.reasoningOutputTokens += entry.reasoningOutputTokens
    existing.totalTokens += entry.totalTokens
    rows.set(entry.modelKey, existing)
  }
  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}

export function getScopedSessionPrimaryModel(
  session: CodexUsagePersistedState['sessions'][number],
  scope: CodexUsageScope
): string | null {
  const scopedModels = getScopedSessionModels(session, scope)
  if (scopedModels.length === 0) {
    return session.primaryModel
  }
  if (scopedModels.length === 1) {
    return scopedModels[0]?.modelLabel ?? null
  }
  return 'Mixed models'
}
