export type RendererRecoveryCircuitBreakerOptions = {
  /** Rolling window in milliseconds. */
  windowMs: number
  maxRecoveries: number
}

// Bound automatic reloads so persistent renderer faults cannot reload forever.
export const DEFAULT_RENDERER_RECOVERY_WINDOW_MS = 60_000
export const DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES = 3

// Keep history across successful loads: crash loops can finish loading on every cycle.
export class RendererRecoveryCircuitBreaker {
  private readonly windowMs: number
  private readonly maxRecoveries: number
  private attempts: number[] = []

  constructor(options: RendererRecoveryCircuitBreakerOptions) {
    this.windowMs = options.windowMs
    this.maxRecoveries = options.maxRecoveries
  }

  recentRecoveryCount(now: number): number {
    this.pruneExpired(now)
    return this.attempts.length
  }

  /** Count allowed attempts only; rejected attempts do not extend the recovery window. */
  registerRecoveryAttempt(now: number): { allowed: boolean; recentRecoveryCount: number } {
    this.pruneExpired(now)
    if (this.attempts.length >= this.maxRecoveries) {
      return { allowed: false, recentRecoveryCount: this.attempts.length }
    }
    this.attempts.push(now)
    return { allowed: true, recentRecoveryCount: this.attempts.length }
  }

  /** Clear history after an explicit recovery action such as a manual reload. */
  reset(): void {
    this.attempts = []
  }

  private pruneExpired(now: number): void {
    const cutoff = now - this.windowMs
    this.attempts = this.attempts.filter((timestamp) => timestamp > cutoff)
  }
}
