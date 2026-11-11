import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocalUsageDay, getUsageRangeCutoff } from './usage-calendar-range'

describe('usage calendar ranges', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 3, 10, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['7d', '2026-04-04'],
    ['30d', '2026-03-12'],
    ['90d', '2026-01-11'],
    ['all', null]
  ] as const)('uses an inclusive local-calendar cutoff for %s', (range, expected) => {
    expect(getUsageRangeCutoff(range)).toBe(expected)
  })

  it('maps timestamps to local calendar days and rejects invalid values', () => {
    const localTimestamp = new Date(2026, 3, 4, 23, 30).toISOString()

    expect(getLocalUsageDay(localTimestamp)).toBe('2026-04-04')
    expect(getLocalUsageDay('not-a-date')).toBeNull()
  })
})
