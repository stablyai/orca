import type { UsageRange } from '../../shared/usage-range'
import { getLocalUsageDay, getUsageRangeCutoff } from './usage-calendar-range'

/** Selects daily aggregates by calendar cutoff and optional Orca workspace attribution. */
export function filterUsageDaily<T extends { day: string; worktreeId: string | null }>(
  daily: readonly T[],
  scope: 'orca' | 'all',
  range: UsageRange
): T[] {
  const cutoff = getUsageRangeCutoff(range)
  return daily.filter((entry) => {
    if (cutoff && entry.day < cutoff) {
      return false
    }
    return scope === 'all' || entry.worktreeId !== null
  })
}

/** Selects sessions by their last local-calendar day and optional Orca workspace attribution. */
export function filterUsageSessions<
  T extends {
    lastTimestamp: string
    locationBreakdown: readonly { worktreeId: string | null }[]
  }
>(sessions: readonly T[], scope: 'orca' | 'all', range: UsageRange): T[] {
  const cutoff = getUsageRangeCutoff(range)
  return sessions.filter((session) => {
    const day = getLocalUsageDay(session.lastTimestamp)
    if (!day || (cutoff && day < cutoff)) {
      return false
    }
    return scope === 'all' || session.locationBreakdown.some((entry) => entry.worktreeId !== null)
  })
}
