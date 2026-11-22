import { describe, expect, it } from 'vitest'
import { zonedMidnight } from './google-time-zone'

describe('zonedMidnight', () => {
  it('uses the offset in force as the day starts when the clocks change that day', () => {
    // New York changes at 02:00, so midnight keeps the previous offset.
    expect(zonedMidnight('2026-03-08', 'America/New_York')).toBe('2026-03-08T00:00:00-05:00')
    expect(zonedMidnight('2026-11-01', 'America/New_York')).toBe('2026-11-01T00:00:00-04:00')
    // Beirut and Santiago skip 00:00-01:00, so the day starts as the old offset reaches 00:00.
    expect(zonedMidnight('2026-03-29', 'Asia/Beirut')).toBe('2026-03-29T00:00:00+02:00')
    expect(zonedMidnight('2026-09-06', 'America/Santiago')).toBe('2026-09-06T00:00:00-04:00')
  })
})
