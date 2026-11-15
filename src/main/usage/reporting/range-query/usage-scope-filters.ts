import { getLocalUsageDay, getUsageRangeCutoff } from './usage-calendar-range'

export function filterUsageDaily<T extends { day: string; worktreeId: string | null }>(
  daily: readonly T[],
  scope: 'orca' | 'all',
  range: '7d' | '30d' | '90d' | 'all'
): T[] {
  const cutoff = getUsageRangeCutoff(range)
  return daily.filter((entry) => {
    if (cutoff && entry.day < cutoff) {
      return false
    }
    return scope === 'all' || entry.worktreeId !== null
  })
}

export function filterUsageSessions<
  T extends {
    lastTimestamp: string
    locationBreakdown: readonly { worktreeId: string | null }[]
  }
>(sessions: readonly T[], scope: 'orca' | 'all', range: '7d' | '30d' | '90d' | 'all'): T[] {
  const cutoff = getUsageRangeCutoff(range)
  return sessions.filter((session) => {
    const day = getLocalUsageDay(session.lastTimestamp)
    if (!day || (cutoff && day < cutoff)) {
      return false
    }
    return scope === 'all' || session.locationBreakdown.some((entry) => entry.worktreeId !== null)
  })
}
