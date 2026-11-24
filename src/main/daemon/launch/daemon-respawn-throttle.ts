/** A sliding window contains crash loops while allowing repaired hosts to recover without a runtime restart. */
export type DaemonRespawnAdmission =
  | { allowed: true }
  | { allowed: false; reason: 'crash_loop'; attemptsInWindow: number; retryAfterMs: number }

export type DaemonRespawnThrottleOptions = {
  maxAttempts?: number
  windowMs?: number
  now?: () => number
}

// Allow occasional restarts while bounding repeated launch attempts.
export const DEFAULT_DAEMON_RESPAWN_MAX_ATTEMPTS = 5
export const DEFAULT_DAEMON_RESPAWN_WINDOW_MS = 60_000

export class DaemonRespawnThrottle {
  private readonly maxAttempts: number
  private readonly windowMs: number
  private readonly now: () => number
  private attempts: number[] = []

  constructor(options: DaemonRespawnThrottleOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_DAEMON_RESPAWN_MAX_ATTEMPTS
    this.windowMs = options.windowMs ?? DEFAULT_DAEMON_RESPAWN_WINDOW_MS
    this.now = options.now ?? Date.now
  }

  admit(): DaemonRespawnAdmission {
    const now = this.now()
    this.attempts = this.attempts.filter((at) => now - at < this.windowMs)
    if (this.attempts.length >= this.maxAttempts) {
      const oldest = this.attempts[0] as number
      return {
        allowed: false,
        reason: 'crash_loop',
        attemptsInWindow: this.attempts.length,
        retryAfterMs: Math.max(0, this.windowMs - (now - oldest))
      }
    }
    this.attempts.push(now)
    return { allowed: true }
  }

  /** A successful fork can still crash immediately; reset only after proven recovery or an explicit restart. */
  reset(): void {
    this.attempts = []
  }
}

export class DaemonCrashLoopError extends Error {
  readonly code = 'daemon_crash_loop'
  constructor(admission: Extract<DaemonRespawnAdmission, { allowed: false }>) {
    super(
      `The terminal daemon has failed ${admission.attemptsInWindow} times in a row; refusing to ` +
        `respawn it for another ${Math.ceil(admission.retryAfterMs / 1000)}s. Terminals will not ` +
        'start until the underlying failure is fixed (check the daemon log).'
    )
    this.name = 'DaemonCrashLoopError'
  }
}
