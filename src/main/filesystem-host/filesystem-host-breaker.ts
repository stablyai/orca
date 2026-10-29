export type FilesystemHostBreakerState = 'closed' | 'open' | 'probe'

export class FilesystemHostBreaker {
  private state: FilesystemHostBreakerState = 'closed'
  private retryAt = 0

  constructor(private readonly recoveryDelayMs: number) {}

  admit(now: number): { allowed: boolean; probe: boolean } {
    if (this.state === 'closed') {
      return { allowed: true, probe: false }
    }
    if (this.state === 'open' && now >= this.retryAt) {
      this.state = 'probe'
      return { allowed: true, probe: true }
    }
    return { allowed: false, probe: false }
  }

  recordSuccess(probe: boolean): void {
    if (probe) {
      this.state = 'closed'
      this.retryAt = 0
    }
  }

  recordFailure(now: number): void {
    this.state = 'open'
    this.retryAt = now + this.recoveryDelayMs
  }

  deferProbe(): void {
    if (this.state === 'probe') {
      this.state = 'open'
    }
  }

  snapshot(): { state: FilesystemHostBreakerState; retryAt: number } {
    return { state: this.state, retryAt: this.retryAt }
  }
}
