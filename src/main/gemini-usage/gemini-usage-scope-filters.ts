import type { GeminiUsageRange, GeminiUsageScope } from '../../shared/gemini-usage-types'
import type { GeminiUsagePersistedState } from './types'
import { getUsageRangeCutoff } from '../usage/usage-calendar-range'
import { addCost } from './gemini-usage-cost-estimate'

export type ScopedGeminiUsageModelRow = {
  modelKey: string
  modelLabel: string
  hasInferredPricing: boolean
  estimatedCostUsd: number | null
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export function getFilteredDaily(
  state: GeminiUsagePersistedState,
  scope: GeminiUsageScope,
  range: GeminiUsageRange
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
  state: GeminiUsagePersistedState,
  scope: GeminiUsageScope,
  range: GeminiUsageRange
) {
  const cutoff = getUsageRangeCutoff(range)
  return state.sessions.filter((session) => {
    if (cutoff && session.lastTimestamp < cutoff) {
      return false
    }
    if (scope === 'orca') {
      return session.locationBreakdown.some((loc) => loc.worktreeId !== null)
    }
    return true
  })
}

export function getScopedSessionModels(
  session: GeminiUsagePersistedState['sessions'][number],
  scope: GeminiUsageScope
): ScopedGeminiUsageModelRow[] {
  if (scope === 'all' || session.locationModelBreakdown.length === 0) {
    return session.modelBreakdown
  }

  const rows = new Map<string, ScopedGeminiUsageModelRow>()
  for (const entry of session.locationModelBreakdown) {
    if (entry.worktreeId === null) {
      continue
    }
    const current = rows.get(entry.modelKey)
    if (!current) {
      rows.set(entry.modelKey, {
        modelKey: entry.modelKey,
        modelLabel: entry.modelLabel,
        hasInferredPricing: entry.hasInferredPricing,
        estimatedCostUsd: entry.estimatedCostUsd,
        eventCount: entry.eventCount,
        inputTokens: entry.inputTokens,
        cachedInputTokens: entry.cachedInputTokens,
        outputTokens: entry.outputTokens,
        reasoningOutputTokens: entry.reasoningOutputTokens,
        totalTokens: entry.totalTokens
      })
      continue
    }
    current.estimatedCostUsd = addCost(current.estimatedCostUsd, entry.estimatedCostUsd)
    current.eventCount += entry.eventCount
    current.inputTokens += entry.inputTokens
    current.cachedInputTokens += entry.cachedInputTokens
    current.outputTokens += entry.outputTokens
    current.reasoningOutputTokens += entry.reasoningOutputTokens
    current.totalTokens += entry.totalTokens
    current.hasInferredPricing ||= entry.hasInferredPricing
  }
  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}

export function getScopedSessionPrimaryModel(
  session: GeminiUsagePersistedState['sessions'][number],
  scope: GeminiUsageScope
): string | null {
  if (scope === 'all') {
    return session.primaryModel
  }
  const models = getScopedSessionModels(session, scope)
  return models[0]?.modelLabel ?? session.primaryModel
}
