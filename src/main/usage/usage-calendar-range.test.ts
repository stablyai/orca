import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocalUsageDay, getUsageRangeCutoff } from './usage-calendar-range'
import { filterUsageDaily, filterUsageSessions } from './usage-scope-filters'

describe('usage calendar ranges', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 3, 10, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['today', '2026-04-10'],
    ['7d', '2026-04-04'],
    ['30d', '2026-03-12'],
    ['90d', '2026-01-11'],
    ['all', null]
  ] as const)('uses an inclusive local-calendar cutoff for %s', (range, expected) => {
    expect(getUsageRangeCutoff(range)).toBe(expected)
  })

  it('keeps only today in daily totals and session lists across local midnight', () => {
    vi.setSystemTime(new Date(2026, 3, 10, 0, 5))
    const daily = [
      { day: '2026-04-09', worktreeId: 'workspace' },
      { day: '2026-04-10', worktreeId: 'workspace' },
      { day: '2026-04-10', worktreeId: null }
    ]
    expect(filterUsageDaily(daily, 'orca', 'today')).toEqual([daily[1]])
    expect(filterUsageDaily(daily, 'all', 'today')).toEqual(daily.slice(1))
    const sessions = [
      {
        lastTimestamp: new Date(2026, 3, 9, 23, 59).toISOString(),
        locationBreakdown: [{ worktreeId: 'workspace' }]
      },
      {
        lastTimestamp: new Date(2026, 3, 10, 0, 1).toISOString(),
        locationBreakdown: [{ worktreeId: 'workspace' }]
      }
    ]
    expect(filterUsageSessions(sessions, 'orca', 'today')).toEqual([sessions[1]])
  })

  it('counts calendar days across month boundaries and daylight-saving changes', () => {
    vi.setSystemTime(new Date(2026, 2, 9, 0, 5))
    expect(getUsageRangeCutoff('today')).toBe('2026-03-09')
    expect(getUsageRangeCutoff('7d')).toBe('2026-03-03')
    expect(getUsageRangeCutoff('30d')).toBe('2026-02-08')
  })

  it('maps timestamps to local calendar days and rejects invalid values', () => {
    const localTimestamp = new Date(2026, 3, 4, 23, 30).toISOString()

    expect(getLocalUsageDay(localTimestamp)).toBe('2026-04-04')
    expect(getLocalUsageDay('not-a-date')).toBeNull()
  })
})
