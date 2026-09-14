import type {
  ClaudeUsageRange,
  ClaudeUsageScope,
  ClaudeUsageSessionRow
} from '../../shared/claude-usage-types'
import type { ClaudeUsagePersistedState } from './types'
import { getSessionProjectLabel } from './usage-aggregation'
import { getFilteredSessions } from './claude-usage-scope-filters'

export function buildRecentSessions(
  state: ClaudeUsagePersistedState,
  scope: ClaudeUsageScope,
  range: ClaudeUsageRange,
  limit = 12
): ClaudeUsageSessionRow[] {
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
          acc.turns += entry.turnCount
          acc.inputTokens += entry.inputTokens
          acc.outputTokens += entry.outputTokens
          acc.cacheReadTokens += entry.cacheReadTokens
          acc.cacheWriteTokens += entry.cacheWriteTokens
          return acc
        },
        {
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
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
        projectLabel: getSessionProjectLabel(scopedLocations),
        branch: session.lastGitBranch,
        model: session.model,
        turns: totals.turns,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens
      }
    })
}
