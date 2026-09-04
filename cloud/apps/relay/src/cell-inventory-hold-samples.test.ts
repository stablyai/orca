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
})
