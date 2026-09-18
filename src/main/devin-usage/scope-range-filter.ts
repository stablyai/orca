import type { DevinUsageRange, DevinUsageScope } from '../../shared/devin-usage-types'
import type { DevinUsageDailyAggregate, DevinUsageSession } from './types'
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
