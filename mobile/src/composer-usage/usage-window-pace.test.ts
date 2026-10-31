import { describe, expect, it } from 'vitest'
import { computeUsagePace } from './usage-window-pace'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000
// A 5h window two hours in: an even burn has used 40%.
const fiveHourWindow = (usedPercent: number) => ({
  usedPercent,
  windowMinutes: 300,
  resetsAt: NOW + 3 * HOUR
})

describe('computeUsagePace', () => {
  it('reads usage near the even burn as on pace', () => {
    expect(computeUsagePace(fiveHourWindow(41), NOW)).toEqual({ kind: 'on-pace', deltaPercent: 1 })
  })

  it('projects how long before reset a fast burn runs out', () => {
    // 80% in 2h burns 40%/h, so the last 20% lasts 30m of the 3h left.
    expect(computeUsagePace(fiveHourWindow(80), NOW)).toEqual({
      kind: 'ahead',
      deltaPercent: 40,
      runOutBeforeResetMs: 2.5 * HOUR
    })
  })

  it('reports how far under an even burn a slow window is', () => {
    expect(computeUsagePace(fiveHourWindow(10), NOW)).toEqual({ kind: 'under', deltaPercent: 30 })
  })

  it('cannot judge pace without a reset time or after the reset passed', () => {
    expect(computeUsagePace({ ...fiveHourWindow(50), resetsAt: null }, NOW)).toEqual({
      kind: 'unknown'
    })
    expect(computeUsagePace({ ...fiveHourWindow(50), resetsAt: NOW - 1 }, NOW)).toEqual({
      kind: 'unknown'
    })
  })
})
