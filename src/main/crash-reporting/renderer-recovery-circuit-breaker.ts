export type RendererRecoveryCircuitBreakerOptions = {
  /** Rolling window in which auto-recoveries are counted. */
  windowMs: number
  /** Max auto-recoveries allowed within the window before the breaker opens. */
  maxRecoveries: number
}

// Why: a deterministic per-load renderer fault (bad GPU driver, corrupt chunk,
// AV interference) crashes on every load. Orca auto-reloads recoverable
// renderer deaths, so without a breaker it reloads every ~0.25-1.3s forever,
// burning CPU and spamming breadcrumbs (Windows clusters F0BDRAZN55L /
// F0BDPCL93UM). 3 reloads in 60s is well above any single transient crash but
// far below a runaway loop.
export const DEFAULT_RENDERER_RECOVERY_WINDOW_MS = 60_000
export const DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES = 3

/**
 * Tracks recent auto-recovery attempts in a rolling time window and decides
 * whether another auto-reload should proceed. Pure and deterministic: callers
 * pass `now` so behavior is testable without timers.
 *
 * The window is NOT reset when the renderer reaches `did-finish-load`: a crash
 * loop renders successfully on every cycle before dying, so a load-based reset
 * would never let the breaker trip. Stale attempts instead age out of the
 * window naturally once the renderer survives longer than `windowMs`.
 */
export class RendererRecoveryCircuitBreaker {
  private readonly windowMs: number
  private readonly maxRecoveries: number
  private attempts: number[] = []

  constructor(options: RendererRecoveryCircuitBreakerOptions) {
    this.windowMs = options.windowMs
    this.maxRecoveries = options.maxRecoveries
  }

  /** Number of recovery attempts still inside the rolling window at `now`. */
  recentRecoveryCount(now: number): number {
    this.pruneExpired(now)
    return this.attempts.length
  }

  /**
   * Records an auto-recovery attempt at `now` and reports whether it is allowed.
   * Returns `false` once `maxRecoveries` have already occurred within the
   * window — the caller must then stop auto-reloading.
   */
  registerRecoveryAttempt(now: number): { allowed: boolean; recentRecoveryCount: number } {
    this.pruneExpired(now)
    if (this.attempts.length >= this.maxRecoveries) {
      return { allowed: false, recentRecoveryCount: this.attempts.length }
    }
    this.attempts.push(now)
    return { allowed: true, recentRecoveryCount: this.attempts.length }
  }

  /** Clears history, e.g. after a manual reload or relaunch resolves the loop. */
  reset(): void {
    this.attempts = []
  }

  private pruneExpired(now: number): void {
    const cutoff = now - this.windowMs
    this.attempts = this.attempts.filter((timestamp) => timestamp > cutoff)
  }
}
