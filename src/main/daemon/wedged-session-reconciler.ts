import type { Session } from './session'

// Why: a wedged ConPTY can leave a force-killed session isAlive forever (node-pty never fires onExit).
export const WEDGED_SESSION_RECONCILE_INTERVAL_MS = 30_000

/** Periodically reaps force-killed sessions whose OS process is already gone, so a wedged ConPTY's ghost
 *  stops reappearing in listSessions()/the renderer's orphan panel. */
export class WedgedSessionReconciler {
  private timer: ReturnType<typeof setInterval> | null = null

  /** Begins the periodic sweep over `sessions`. Idempotent: a second call keeps the existing timer so the
   *  sweep rate cannot double. The timer is unref'd so it never keeps the daemon process alive. */
  start(sessions: ReadonlyMap<string, Session>): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => this.sweep(sessions), WEDGED_SESSION_RECONCILE_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Cancels the periodic sweep. Idempotent, and safe to call when never started. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Asks every session to reconcile itself. `reconcileWedgedExit` no-ops unless the session was
   *  force-killed, so live sessions are untouched; deleting from the map mid-iteration (which the reaper
   *  does when a session synthesizes its exit) is safe for a Map for-of. */
  private sweep(sessions: ReadonlyMap<string, Session>): void {
    for (const [, session] of sessions) {
      session.reconcileWedgedExit()
    }
  }
}
