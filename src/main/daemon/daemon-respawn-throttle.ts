/**
 * Crash-loop containment for the terminal daemon.
 *
 * The respawn path is driven by `ensureConnected()`: every reconnect attempt against a dead
 * socket forks a replacement. A daemon that dies during startup — a broken node-pty, an
 * unwritable runtime dir, a wrong libc — therefore forks forever, as fast as the caller
 * retries. On the desktop that burns CPU; under orcad, where a supervisor is watching a
 * process that never reports failure, it is the "restart-spin while the deploy reports
 * success" shape the ops contract has to rule out.
 *
 * Sliding window, not a permanent trip: the failure is usually environmental, and an
 * environment can be repaired without restarting the runtime. Once the window drains, the
 * next attempt is admitted and a repaired host recovers on its own.
 */
export type DaemonRespawnAdmission =
  | { allowed: true }
  | { allowed: false; reason: 'crash_loop'; attemptsInWindow: number; retryAfterMs: number }

export type DaemonRespawnThrottleOptions = {
  /** Attempts allowed inside `windowMs` before the next one is refused. */
  maxAttempts?: number
  windowMs?: number
  now?: () => number
}

// Generous on purpose: a user manually restarting the daemon a few times, or a laptop
// waking to a stale socket, must never trip this. Five failures inside a minute is a
// daemon that cannot start, not a daemon having a bad moment.
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

  /** Record and admit one respawn attempt, or refuse it as a crash loop. */
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

  /**
   * Forget the recorded attempts.
   *
   * Why not automatic on a successful fork: a crash loop IS a sequence of successful forks
   * followed by immediate deaths, so "the fork returned" is not evidence of recovery. Only
   * a caller that knows the daemon stayed up — or a deliberate operator restart — may clear
   * the window.
   */
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
