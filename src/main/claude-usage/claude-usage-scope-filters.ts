import type { ClaudeUsageRange, ClaudeUsageScope } from '../../shared/claude-usage-types'
import type { ClaudeUsagePersistedState } from './types'
import { getLocalUsageDay, getUsageRangeCutoff } from '../usage/usage-calendar-range'

export function getFilteredDaily(
  state: ClaudeUsagePersistedState,
  scope: ClaudeUsageScope,
  range: ClaudeUsageRange
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
  state: ClaudeUsagePersistedState,
  scope: ClaudeUsageScope,
  range: ClaudeUsageRange
) {
  const cutoff = getUsageRangeCutoff(range)
  return state.sessions.filter((session) => {
    // Why: daily aggregates use local calendar days, so session filtering has
    // to use the same conversion or the sessions table/counts can disagree
    // with the chart around UTC day boundaries.
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
