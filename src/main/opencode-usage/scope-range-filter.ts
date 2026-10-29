import type { OpenCodeUsageRange, OpenCodeUsageScope } from '../../shared/opencode-usage-types'
import type { OpenCodeUsageDailyAggregate, OpenCodeUsageSession } from './types'
import { getLocalUsageDay, getUsageRangeCutoff } from '../usage/usage-calendar-range'

export function filterDailyAggregatesByScopeAndRange(
  dailyAggregates: OpenCodeUsageDailyAggregate[],
  scope: OpenCodeUsageScope,
  range: OpenCodeUsageRange
): OpenCodeUsageDailyAggregate[] {
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
  sessions: OpenCodeUsageSession[],
  scope: OpenCodeUsageScope,
  range: OpenCodeUsageRange
): OpenCodeUsageSession[] {
  const cutoff = getUsageRangeCutoff(range)
  return sessions.filter((session) => {
    if (scope === 'orca' && !session.primaryWorktreeId) {
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
