// Why 10 minutes: the daemon's only job is holding PTY sessions across app
// restarts/updates, so at 0 sessions there is nothing to preserve — the grace
// only needs to outlast the reconnect window of an app update or restart
// (seconds to a couple of minutes) plus headroom for a badly stalled machine,
// while still bounding how long an orphaned daemon pins node + node-pty memory.
export const DAEMON_IDLE_EXIT_GRACE_MS = 10 * 60 * 1000

export type DaemonIdleExitOptions = {
  /** Must return true only when the daemon holds zero sessions AND zero
   *  connected clients. Re-checked at fire time, not just at arm time. */
  isIdle: () => boolean
  onExpired: () => void
  graceMs?: number
}

/**
 * Arms a single unref'd countdown whenever the daemon becomes idle and cancels
 * it on any transition back to non-idle. Event-driven only — the owner calls
 * evaluate() on every client/session count change; there is no polling.
 */
export class DaemonIdleExit {
  private readonly isIdle: () => boolean
  private readonly onExpired: () => void
  private readonly graceMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(opts: DaemonIdleExitOptions) {
    this.isIdle = opts.isIdle
    this.onExpired = opts.onExpired
    this.graceMs = opts.graceMs ?? DAEMON_IDLE_EXIT_GRACE_MS
  }

  evaluate(): void {
    if (this.disposed) {
      return
    }
    if (!this.isIdle()) {
      this.cancel()
      return
    }
    if (this.timer) {
      // Why: the grace period measures time since the daemon *became* idle;
      // redundant idle evaluations must not push the deadline out.
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      // Why: fail-safe re-check — if a future code change misses a cancel
      // path, a daemon that gained a session or client since arming must keep
      // running rather than exit and kill live terminals.
      if (!this.disposed && this.isIdle()) {
        this.onExpired()
      }
    }, this.graceMs)
    // Why: an armed idle countdown must never be the thing keeping the daemon
    // process alive once its server has otherwise drained.
    this.timer.unref?.()
  }

  isArmed(): boolean {
    return this.timer !== null
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
