import { isHostAttachTimeout } from '../../../../src/shared/remote-runtime/relay/client/relay-host-offline-streak'

export class RelayRecoveryFailureCount {
  private count = 0
  private attachTimeoutRedialSpent = false
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
    if (resetFirst) {
      this.attachTimeoutRedialSpent = false
    }
    this.update((resetFirst ? 0 : this.count) + 1)
    return this.count
  }

  // Why: one quick redial per streak; a desktop whose data link keeps missing
  // the attach deadline falls back to the known-offline wait.
  claimAttachTimeoutRedial(error: Error | null): boolean {
    if (!isHostAttachTimeout(error) || this.attachTimeoutRedialSpent) {
      return false
    }
    this.attachTimeoutRedialSpent = true
    return true
  }

  recordAfterConnection(connectedAt: number | null, now: number): number {
    return this.record(connectedAt != null && now - connectedAt >= this.stableConnectionMs)
  }

  reset(): void {
    this.attachTimeoutRedialSpent = false
    this.update(0)
  }

  private update(count: number): void {
    if (this.count === count) {
      return
    }
    this.count = count
    this.reporter?.(count)
  }
}
