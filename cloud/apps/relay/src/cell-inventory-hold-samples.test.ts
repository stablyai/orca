import { describe, expect, it } from 'vitest'
import {
  CellInventoryHoldSamples,
  emptyCellInventoryHoldCounts
} from './cell-inventory-hold-samples.js'

// Nearest rank, computed in integer arithmetic so it cannot inherit the float
// error the implementation's `0.95 * n` could in principle carry.
function nearestRankP95(sorted: number[]): number {
  return sorted[Math.ceil((95 * sorted.length) / 100) - 1]!
}

function samplesOf(values: number[]): CellInventoryHoldSamples {
  const samples = new CellInventoryHoldSamples()
  for (const value of values) samples.record(value)
  return samples
}

describe('cell inventory hold samples', () => {
  it('reports nothing before the first hold', () => {
    expect(new CellInventoryHoldSamples().readCounts()).toEqual(
      emptyCellInventoryHoldCounts()
    )
  })

  // Why: the 500ms bound will be tuned against this percentile, so an off-by-one
  // here reads as a hold the fleet never had.
  it('places p95 at the nearest rank for every window size', () => {
    for (let size = 1; size <= 400; size++) {
      const values = Array.from({ length: size }, (_, index) => index + 1)
      const shuffled = [...values].reverse()

      const counts = samplesOf(shuffled).readCounts()

      expect(counts.cellInventoryHoldMsP95).toBe(nearestRankP95(values))
      expect(counts.cellInventoryHoldMsMax).toBe(size)
      expect(counts.cellInventoryHolds).toBe(size)
    }
  })

  it('never reports a p95 above the max', () => {
    for (let size = 1; size <= 200; size++) {
      const counts = samplesOf(Array.from({ length: size }, (_, i) => i + 1)).readCounts()

      expect(counts.cellInventoryHoldMsP95).toBeLessThanOrEqual(counts.cellInventoryHoldMsMax)
    }
  })

  it('ignores a hold that is not a finite, non-negative duration', () => {
    const samples = samplesOf([Number.NaN, Number.POSITIVE_INFINITY, -1])

    expect(samples.readCounts()).toEqual(emptyCellInventoryHoldCounts())
  })

  // Why: the reservoir is bounded, so a heavy flush interval keeps the most
  // recent holds rather than growing without limit or freezing on the oldest.
  it('keeps the most recent holds once the reservoir is full', () => {
    const counts = samplesOf(Array.from({ length: 2_100 }, (_, index) => index + 1)).readCounts()

    expect(counts.cellInventoryHolds).toBe(2_048)
    expect(counts.cellInventoryHoldMsMax).toBe(2_100)
  })

  it('resets the window on consume so each flush reports its own holds', () => {
    const samples = samplesOf([5, 10])

    expect(samples.consumeCounts().cellInventoryHolds).toBe(2)
    expect(samples.consumeCounts()).toEqual(emptyCellInventoryHoldCounts())
  })

  // Why: this is the case the hold metrics alone cannot see. A NOWAIT grab that
  // fails has no duration, so a retry storm used to leave every hold field at
  // zero while the lock was saturated.
  it('counts failed acquisitions in a window that recorded no holds', () => {
    const samples = new CellInventoryHoldSamples()
    for (let attempt = 0; attempt < 65; attempt++) samples.recordUnavailable()

    const counts = samples.readCounts()

    expect(counts.cellInventoryLockUnavailable).toBe(65)
    expect(counts.cellInventoryHolds).toBe(0)
    expect(counts.cellInventoryHoldMsMax).toBe(0)
  })

  it('reports failed acquisitions alongside the holds that did succeed', () => {
    const samples = samplesOf([12, 34])
    samples.recordUnavailable(3)

    expect(samples.readCounts()).toMatchObject({
      cellInventoryHolds: 2,
      cellInventoryHoldMsMax: 34,
      cellInventoryLockUnavailable: 3
    })
  })

  it('ignores a failure count that is not a positive number', () => {
    const samples = new CellInventoryHoldSamples()
    samples.recordUnavailable(0)
    samples.recordUnavailable(-2)
    samples.recordUnavailable(Number.NaN)

    expect(samples.readCounts()).toEqual(emptyCellInventoryHoldCounts())
  })

  it('resets failed acquisitions on consume', () => {
    const samples = new CellInventoryHoldSamples()
    samples.recordUnavailable(4)

    expect(samples.consumeCounts().cellInventoryLockUnavailable).toBe(4)
    expect(samples.consumeCounts()).toEqual(emptyCellInventoryHoldCounts())
  })

  // Why: the alert reads one max across every lock, so the label is the only
  // thing that says whether a long hold was the inventory or a rehome target row.
  it('names the site of the longest hold and reports rehome target rows apart', () => {
    const samples = new CellInventoryHoldSamples()
    samples.record(40)
    samples.record(170, 'rehome-target-row')
    samples.record(90, 'rehome-target-row')

    expect(samples.readCounts()).toMatchObject({
      cellInventoryHoldMsMax: 170,
      cellInventoryHolds: 3,
      cellInventoryHoldMaxSite: 'rehome-target-row',
      rehomeTargetRowHoldMsMax: 170,
      rehomeTargetRowHolds: 2
    })
    samples.record(300)
    expect(samples.readCounts()).toMatchObject({
      cellInventoryHoldMaxSite: 'inventory',
      rehomeTargetRowHoldMsMax: 170
    })
  })
})
