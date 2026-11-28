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

  it('extrapolates linearly from 0% at reset to the first reading and connects to now', () => {
    const model = buildUsageChartModel(
      weekly(24),
      [{ at: NOW - HOUR, usedPercent: 20 }],
      NOW,
      'used'
    )
    expect(model).not.toBeNull()
    expect(model?.startsAt).toBe(NOW - 2 * DAY)
    expect(model?.endsAt).toBe(NOW + 5 * DAY)
    expect(model?.firstAt).toBe(NOW - HOUR)
    expect(model?.lastRecordedAt).toBe(NOW - HOUR)
    expect(model?.extrapolated).toEqual([
      {
        from: { at: NOW - 2 * DAY, value: 0 },
        to: { at: NOW - HOUR, value: 20 }
      }
    ])
    // 1h is within weekly gapMs, so live current value connects smoothly to Now in the run.
    expect(model?.runs).toEqual([
      [
        { at: NOW - HOUR, value: 20 },
        { at: NOW, value: 24 }
      ]
    ])
    expect(model?.current).toEqual({ at: NOW, value: 24 })
  })

  it('extrapolates both sides of a single stale reading when last reading to now exceeds a gap', () => {
    const model = buildUsageChartModel(
      weekly(30),
      [{ at: NOW - 8 * HOUR, usedPercent: 18 }],
      NOW,
      'used'
    )
    expect(model?.runs).toEqual([[{ at: NOW - 8 * HOUR, value: 18 }]])
    expect(model?.extrapolated).toEqual([
      { from: { at: NOW - 2 * DAY, value: 0 }, to: { at: NOW - 8 * HOUR, value: 18 } },
      { from: { at: NOW - 8 * HOUR, value: 18 }, to: { at: NOW, value: 30 } }
    ])
    expect(model?.firstAt).toBe(NOW - 8 * HOUR)
    expect(model?.lastRecordedAt).toBe(NOW - 8 * HOUR)
  })

  it('extrapolates from 0% at reset to now when there are zero readings in the window', () => {
    const empty = buildUsageChartModel(weekly(35), [], NOW, 'used')
    expect(empty?.firstAt).toBeNull()
    expect(empty?.lastRecordedAt).toBeNull()
    expect(empty?.runs).toEqual([])
    expect(empty?.extrapolated).toEqual([
      { from: { at: NOW - 2 * DAY, value: 0 }, to: { at: NOW, value: 35 } }
    ])
    expect(empty?.current).toEqual({ at: NOW, value: 35 })

    // Samples only from an older window still produce the reset→now extrapolation.
    const priorOnly = buildUsageChartModel(
      weekly(20),
      [{ at: NOW - 3 * DAY, usedPercent: 50 }],
      NOW,
      'used'
    )
    expect(priorOnly?.firstAt).toBeNull()
    expect(priorOnly?.extrapolated).toEqual([
      { from: { at: NOW - 2 * DAY, value: 0 }, to: { at: NOW, value: 20 } }
    ])

    // Zero usage renders a clean 0% baseline up to now.
    const zero = buildUsageChartModel(weekly(0), [], NOW, 'used')
    expect(zero?.extrapolated).toEqual([
      { from: { at: NOW - 2 * DAY, value: 0 }, to: { at: NOW, value: 0 } }
    ])
    // Invalid window length still returns null.
    expect(
      buildUsageChartModel({ usedPercent: 0, windowMinutes: 0, resetsAt: null }, [], NOW, 'used')
    ).toBeNull()
  })

  it('mirrors values, extrapolated segments, and the pace line when counting what remains', () => {
    const model = buildUsageChartModel(weekly(20), samples, NOW, 'remaining')
    expect(model?.runs.flat().map((point) => point.value)).toEqual([98, 80, 80])
    expect(model?.extrapolated).toEqual([
      { from: { at: NOW - 2 * DAY, value: 100 }, to: { at: NOW - 2 * DAY + HOUR, value: 98 } }
    ])
    expect(model?.pace).toEqual({ from: 100, to: 0 })

    const zeroRemaining = buildUsageChartModel(weekly(25), [], NOW, 'remaining')
    expect(zeroRemaining?.extrapolated).toEqual([
      { from: { at: NOW - 2 * DAY, value: 100 }, to: { at: NOW, value: 75 } }
    ])
  })

  it('bridges recording gaps with extrapolated segments while preserving observed runs', () => {
    const hourly = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        at: from + index * HOUR,
        usedPercent: 10 + index
      }))
    const model = buildUsageChartModel(
      weekly(30),
      [...hourly(NOW - 30 * HOUR, 6), ...hourly(NOW - 10 * HOUR, 10)],
      NOW,
      'used'
    )
    // Run 1 has 6 points (NOW-30h..NOW-25h), run 2 has 10 points (NOW-10h..NOW-1h) + live NOW.
    expect(model?.runs.map((run) => run.length)).toEqual([6, 11])
    expect(model?.extrapolated).toEqual([
      { from: { at: NOW - 2 * DAY, value: 0 }, to: { at: NOW - 30 * HOUR, value: 10 } },
      { from: { at: NOW - 25 * HOUR, value: 15 }, to: { at: NOW - 10 * HOUR, value: 10 } }
    ])
  })

  it('has no extrapolated segments when recorded history covers the full span from reset to now', () => {
    const startsAt = NOW - 2 * DAY
    const fullHistory = Array.from({ length: 49 }, (_, index) => ({
      at: startsAt + index * HOUR,
      usedPercent: index
    }))
    const model = buildUsageChartModel(weekly(48), fullHistory, NOW, 'used')
    expect(model?.runs).toHaveLength(1)
    expect(model?.runs[0]).toHaveLength(49)
    expect(model?.extrapolated).toEqual([])
    expect(model?.firstAt).toBe(startsAt)
    expect(model?.lastRecordedAt).toBe(NOW)
  })
})
