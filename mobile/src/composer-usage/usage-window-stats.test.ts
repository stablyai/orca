import { describe, expect, it } from 'vitest'
import { buildUsageChartModel, computeUsageWindowStats } from './usage-window-stats'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000
// A week-long window two days in, resetting in five days.
const weekly = (usedPercent: number) => ({
  usedPercent,
  windowMinutes: 7 * 24 * 60,
  resetsAt: NOW + 5 * DAY
})

describe('computeUsageWindowStats', () => {
  it('derives pace delta, daily budget, projection and recent use', () => {
    const samples = [
      { at: NOW - 2 * DAY + HOUR, usedPercent: 2 },
      { at: NOW - DAY - HOUR, usedPercent: 10 },
      { at: NOW - HOUR, usedPercent: 20 }
    ]
    const stats = computeUsageWindowStats(weekly(20), samples, NOW)
    // An even burn has spent 2/7 ≈ 28.57% two days in.
    expect(stats.paceDeltaPoints).toBeCloseTo(20 - 200 / 7, 6)
    expect(stats.budgetPercent).toBeCloseTo(80 / 5, 6)
    expect(stats.budgetPeriodMs).toBe(DAY)
    // 10%/day for 5 more days.
    expect(stats.projectedAtReset).toBeCloseTo(70, 6)
    expect(stats.recentLookbackMs).toBe(DAY)
    expect(stats.recentPoints).toBe(10)
  })

  it('caps the projection at the limit', () => {
    expect(computeUsageWindowStats(weekly(80), [], NOW).projectedAtReset).toBe(100)
  })

  it('counts all usage when the window began inside the lookback', () => {
    const window = { usedPercent: 30, windowMinutes: 300, resetsAt: NOW + 4.5 * HOUR }
    const stats = computeUsageWindowStats(window, [], NOW)
    expect(stats.recentLookbackMs).toBe(HOUR)
    expect(stats.recentPoints).toBe(30)
    // 70% over the 4.5 hours left.
    expect(stats.budgetPercent).toBeCloseTo(70 / 4.5, 6)
  })

  it('leaves recent use unknown when history does not reach back far enough', () => {
    const stats = computeUsageWindowStats(weekly(20), [{ at: NOW - HOUR, usedPercent: 19 }], NOW)
    expect(stats.recentPoints).toBeNull()
  })

  it('hides pace-based stats without a reset time', () => {
    const stats = computeUsageWindowStats(
      { usedPercent: 20, windowMinutes: 10080, resetsAt: null },
      [],
      NOW
    )
    expect(stats.paceDeltaPoints).toBeNull()
    expect(stats.budgetPercent).toBeNull()
    expect(stats.projectedAtReset).toBeNull()
  })
})

describe('buildUsageChartModel', () => {
  const samples = [
    { at: NOW - 2 * DAY + HOUR, usedPercent: 2 },
    { at: NOW - HOUR, usedPercent: 20 }
  ]

  it('needs two readings inside the window', () => {
    expect(buildUsageChartModel(weekly(20), samples.slice(1), NOW, 'used')).toBeNull()
    expect(
      buildUsageChartModel(
        weekly(20),
        [{ at: NOW - 3 * DAY, usedPercent: 50 }, ...samples.slice(1)],
        NOW,
        'used'
      )
    ).toBeNull()
  })

  it('mirrors values and the pace line when counting what remains', () => {
    const model = buildUsageChartModel(weekly(20), samples, NOW, 'remaining')
    expect(model?.points.map((point) => point.value)).toEqual([98, 80])
    // Two days into a week: the even burn has spent 2/7 by now.
    expect(model?.pace?.from).toBeCloseTo(100 - 100 / 7 / 24, 6)
    expect(model?.pace?.to).toBeCloseTo(100 - 200 / 7, 6)
  })

  it('zooms to the recorded history, never less than six hours, ending now', () => {
    const recent = [
      { at: NOW - 2 * HOUR, usedPercent: 30 },
      { at: NOW - HOUR, usedPercent: 35 }
    ]
    const zoomed = buildUsageChartModel(weekly(35), recent, NOW, 'used')
    expect(zoomed?.startsAt).toBe(NOW - 6 * HOUR)
    expect(zoomed?.endsAt).toBe(NOW)
    const long = buildUsageChartModel(weekly(20), samples, NOW, 'used')
    expect(long?.startsAt).toBe(NOW - 2 * DAY + HOUR)
  })
})
