export type SessionSearchBudget = {
  /** Files a single cycle may read. */
  files: number
  /** Transcript bytes a single cycle may read. */
  bytes: number
}

// Why both: a cycle that reads 400 tiny Claude transcripts and one that reads a
// single 80 MB Codex rollout cost about the same wall time, and neither bound
// alone catches both. Defaults are one reconcile interval's worth on the
// measured machine (26 MB/s of transcript), left well under it.
export const DEFAULT_SESSION_SEARCH_BUDGET: SessionSearchBudget = {
  files: 64,
  bytes: 8 * 1024 * 1024
}

/**
 * One cycle's allowance. Work that does not fit is not dropped: the reconciler
 * keeps it queued and the next cycle opens a fresh allowance, so a burst is
 * paced out over cycles rather than either stalling the process or being lost.
 *
 * Unspent allowance does not accumulate. Carrying it would let a long idle
 * stretch buy one unbounded cycle, which is the stall the budget exists to stop.
 */
export class SessionSearchCycleAllowance {
  private files = 0
  private bytes = 0
  private spentAnything = false

  constructor(private readonly perCycle: SessionSearchBudget) {
    this.reset()
  }

  reset(): void {
    this.files = Math.max(1, this.perCycle.files)
    this.bytes = Math.max(0, this.perCycle.bytes)
    this.spentAnything = false
  }

  /**
   * Books one file of `bytes`. False once the cycle is spent; the caller stops
   * and re-queues the rest. A file larger than the whole byte allowance is let
   * through as the cycle's only work, because refusing it forever would leave
   * one big transcript permanently unindexed.
   */
  spend(bytes: number): boolean {
    if (this.files <= 0) {
      return false
    }
    const cost = Math.max(0, bytes)
    if (cost > this.bytes && this.spentAnything) {
      return false
    }
    this.files -= 1
    this.bytes = Math.max(0, this.bytes - cost)
    this.spentAnything = true
    return true
  }

  get remaining(): SessionSearchBudget {
    return { files: this.files, bytes: this.bytes }
  }
}
