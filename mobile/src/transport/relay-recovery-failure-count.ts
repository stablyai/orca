export class RelayRecoveryFailureCount {
  private count = 0
  private reporter: ((count: number) => void) | null = null

  constructor(private readonly stableConnectionMs: number) {}

  current(): number {
    return this.count
  }

  reportTo(reporter: (count: number) => void): void {
    this.reporter = reporter
    reporter(this.count)
  }

  record(resetFirst: boolean): number {
    this.update((resetFirst ? 0 : this.count) + 1)
    return this.count
  }

  recordAfterConnection(connectedAt: number | null, now: number): number {
    return this.record(connectedAt != null && now - connectedAt >= this.stableConnectionMs)
  }

  reset(): void {
    this.update(0)
  }

  /** A structured reconnect signal recomputes the streak rather than adding to it: a stream that
   *  proved long-lived retires it, a background restart floors it at one. Routed through `update`
   *  so the recovery-attempt reporter sees the change. */
  recomputeTo(count: number): void {
    this.update(Math.max(0, count))
  }

  private update(count: number): void {
    if (this.count === count) {
      return
    }
    this.count = count
    this.reporter?.(count)
  }
}
