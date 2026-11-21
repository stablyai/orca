/** One stretch in which the writer checkpointed for itself; totals cover this launch. */
export type JournalCheckpointOutage = {
  cause: 'exited' | 'error' | 'unresponsive' | 'slow' | 'spawn'
  outageMs: number
  recovered: boolean
  restarts: number
  totalOutageMs: number
}

/** Stretches without a checkpoint worker, each reported once: when a worker answers, or at close. */
export class JournalCheckpointOutages {
  restarts = 0
  private open: { since: number; cause: JournalCheckpointOutage['cause'] } | undefined
  private totalOutageMs = 0

  constructor(
    private readonly now: () => number,
    private readonly onOutage?: (outage: JournalCheckpointOutage) => void
  ) {}

  begin(cause: JournalCheckpointOutage['cause']): void {
    this.open ??= { since: this.now(), cause }
  }

  /** Returns whether an outage was open. */
  end(recovered: boolean): boolean {
    const open = this.open
    if (!open) {
      return false
    }
    this.open = undefined
    const outageMs = Math.max(0, this.now() - open.since)
    this.totalOutageMs += outageMs
    try {
      this.onOutage?.({
        cause: open.cause,
        outageMs,
        recovered,
        restarts: this.restarts,
        totalOutageMs: this.totalOutageMs
      })
    } catch {
      // Telemetry never affects checkpoints.
    }
    return true
  }
}
