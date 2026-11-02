import type {
  CodexUsageRange,
  CodexUsageScope,
  CodexUsageSessionRow
} from '../../shared/codex-usage-types'
import type { CodexUsagePersistedState } from './types'
import { getFilteredSessions, getScopedSessionPrimaryModel } from './codex-usage-scope-filters'

export function buildRecentSessions(
  state: CodexUsagePersistedState,
  scope: CodexUsageScope,
  range: CodexUsageRange,
  limit = 12
): CodexUsageSessionRow[] {
  return getFilteredSessions(state, scope, range)
    .slice(0, limit)
    .map((session) => {
      const matchingLocations = session.locationBreakdown.filter((entry) =>
        scope === 'all' ? true : entry.worktreeId !== null
      )
      const scopedLocations =
        matchingLocations.length > 0 ? matchingLocations : session.locationBreakdown
      const totals = scopedLocations.reduce(
        (acc, entry) => {
          acc.events += entry.eventCount
          acc.inputTokens += entry.inputTokens
          acc.cachedInputTokens += entry.cachedInputTokens
          acc.outputTokens += entry.outputTokens
          acc.reasoningOutputTokens += entry.reasoningOutputTokens
          acc.totalTokens += entry.totalTokens
          acc.hasInferredPricing ||= entry.hasInferredPricing
          return acc
        },
        {
          events: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          hasInferredPricing: false
        }
      )
      const durationMinutes = Math.max(
        0,
        Math.round(
          (new Date(session.lastTimestamp).getTime() - new Date(session.firstTimestamp).getTime()) /
            60_000
        )
      )
      return {
        sessionId: session.sessionId,
        lastActiveAt: session.lastTimestamp,
        durationMinutes,
        projectLabel:
          scopedLocations.length > 1
            ? 'Multiple locations'
            : (scopedLocations[0]?.projectLabel ?? session.primaryProjectLabel),
        model: getScopedSessionPrimaryModel(session, scope),
        events: totals.events,
        inputTokens: totals.inputTokens,
        cachedInputTokens: totals.cachedInputTokens,
        outputTokens: totals.outputTokens,
        reasoningOutputTokens: totals.reasoningOutputTokens,
        totalTokens: totals.totalTokens,
        hasInferredPricing: session.hasInferredPricing || totals.hasInferredPricing
      }
    })
}
