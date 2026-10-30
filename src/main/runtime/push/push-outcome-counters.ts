type PushOutcome = 'error' | 'rate_limited' | 'rejected' | 'unreachable'

export class PushOutcomeCounters {
  private readonly counts = new Map<PushOutcome, number>()
  private nextLogAt = 0

  constructor(private readonly now: () => number = Date.now) {}

  record(outcome: PushOutcome): void {
    this.counts.set(outcome, (this.counts.get(outcome) ?? 0) + 1)
    if (this.now() < this.nextLogAt) {
      return
    }
    this.nextLogAt = this.now() + 60_000
    this.flush()
  }

  flush(): void {
    if (!this.counts.size) {
      return
    }
    console.warn(
      JSON.stringify({ event: 'orca_desktop_push_failures', ...Object.fromEntries(this.counts) })
    )
    this.counts.clear()
  }
}
