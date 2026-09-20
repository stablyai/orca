// Why: the cell inventory lock is held to COMMIT, and the assignment path runs
// many statements after taking it. Tuning the request-path wait bound needs the
// hold distribution, and no runtime metric carried it before this change.
export type CellInventoryHoldCounts = {
  cellInventoryHoldMsMax: number
  cellInventoryHoldMsP95: number
  cellInventoryHolds: number
  // Why: a failed acquisition produces no hold sample, so the hold fields alone
  // read healthy while the lock is saturated. Split by wait policy, not by
  // caller: fail-fast covers background sweeps that step aside by design AND
  // request-path first attempts that retry, so it reads as contention pressure,
  // not user-visible failure. An expired bounded wait has already spent its
  // budget, so that lane is the one that tracks stalls.
  cellInventoryLockUnavailable: number
  cellInventoryLockTimeouts: number
}

// Bounded so a flush interval with heavy assignment traffic cannot grow the array
// without limit; the reservoir keeps the most recent holds.
const MAX_SAMPLES = 2_048

export function emptyCellInventoryHoldCounts(): CellInventoryHoldCounts {
  return {
    cellInventoryHoldMsMax: 0,
    cellInventoryHoldMsP95: 0,
    cellInventoryHolds: 0,
    cellInventoryLockUnavailable: 0,
    cellInventoryLockTimeouts: 0
  }
}

export class CellInventoryHoldSamples {
  private samples: number[] = []
  private unavailable = 0
  private timeouts = 0

  record(holdMs: number): void {
    if (!Number.isFinite(holdMs) || holdMs < 0) return
    if (this.samples.length === MAX_SAMPLES) this.samples.shift()
    this.samples.push(holdMs)
  }

  // Counted, not sampled: a failed acquisition has no duration to record.
  recordUnavailable(count = 1): void {
    if (!Number.isFinite(count) || count <= 0) return
    this.unavailable += count
  }

  recordLockTimeout(count = 1): void {
    if (!Number.isFinite(count) || count <= 0) return
    this.timeouts += count
  }

  consumeCounts(): CellInventoryHoldCounts {
    const counts = this.readCounts()
    this.samples = []
    this.unavailable = 0
    this.timeouts = 0
    return counts
  }

  readCounts(): CellInventoryHoldCounts {
    const failures = {
      cellInventoryLockUnavailable: this.unavailable,
      cellInventoryLockTimeouts: this.timeouts
    }
    if (this.samples.length === 0) return { ...emptyCellInventoryHoldCounts(), ...failures }
    const sorted = [...this.samples].sort((left, right) => left - right)
    return {
      cellInventoryHoldMsMax: round(sorted[sorted.length - 1]!),
      cellInventoryHoldMsP95: round(sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0),
      cellInventoryHolds: sorted.length,
      ...failures
    }
  }
}

function round(value: number): number {
  return Number(value.toFixed(3))
}
