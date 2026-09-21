// Why: the cell inventory lock is held to COMMIT, and the assignment path runs
// many statements after taking it. Tuning the request-path wait bound needs the
// hold distribution, and no runtime metric carried it before this change.
export type CellInventoryHoldCounts = {
  cellInventoryHoldMsMax: number
  cellInventoryHoldMsP95: number
  cellInventoryHolds: number
}

// Bounded so a flush interval with heavy assignment traffic cannot grow the array
// without limit; the reservoir keeps the most recent holds.
const MAX_SAMPLES = 2_048

export function emptyCellInventoryHoldCounts(): CellInventoryHoldCounts {
  return { cellInventoryHoldMsMax: 0, cellInventoryHoldMsP95: 0, cellInventoryHolds: 0 }
}

export class CellInventoryHoldSamples {
  private samples: number[] = []

  record(holdMs: number): void {
    if (!Number.isFinite(holdMs) || holdMs < 0) return
    if (this.samples.length === MAX_SAMPLES) this.samples.shift()
    this.samples.push(holdMs)
  }

  consumeCounts(): CellInventoryHoldCounts {
    const counts = this.readCounts()
    this.samples = []
    return counts
  }

  readCounts(): CellInventoryHoldCounts {
    if (this.samples.length === 0) return emptyCellInventoryHoldCounts()
    const sorted = [...this.samples].sort((left, right) => left - right)
    return {
      cellInventoryHoldMsMax: round(sorted[sorted.length - 1]!),
      cellInventoryHoldMsP95: round(sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0),
      cellInventoryHolds: sorted.length
    }
  }
}

function round(value: number): number {
  return Number(value.toFixed(3))
}
