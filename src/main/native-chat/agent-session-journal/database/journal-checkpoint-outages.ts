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
  private warned = false

  constructor(
    private readonly now: () => number,
    private readonly onOutage?: (outage: JournalCheckpointOutage) => void
  ) {}

  /** A loss that follows a hand-back to the writer names the outage; it keeps its start. */
  begin(cause: JournalCheckpointOutage['cause']): void {
    if (!this.open || (this.open.cause === 'slow' && cause !== 'slow')) {
      this.open = { since: this.open?.since ?? this.now(), cause }
    }
  }

  /** Warns once until a worker recovers. */
  warn(error: unknown): void {
    if (this.warned) {
      return
    }
    this.warned = true
    try {
      console.warn(
        '[agent-session-journal] checkpoint worker unavailable; writer checkpoints',
        error
      )
    } catch {
      // A diagnostic must never turn a committed write into an apparent failure.
    }
  }

  end(recovered: boolean): void {
    const open = this.open
    if (!open) {
      return
    }
    this.open = undefined
    if (recovered) {
      this.warned = false
    }
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
  }
}
