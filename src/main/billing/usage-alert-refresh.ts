// Keeps usage alerts timely: a team can cross 75/90/100% mid-session, and alerts only fire on a
// billing read. Main owns one app-wide schedule (not one per workspace or per window): it asks the
// main window to re-read billing when a cloud workspace is created or woken, and every 30 minutes
// while at least one is running. The window's read goes through the usual billing IPC, so the
// in-app notice and the desktop notification both update and the per-level ledger still dedupes.
//
// No timer of its own: the poll rides Orca Cloud's existing 30-second lifecycle beat, which
// reports through setRunning(). So nothing extra wakes the app, and a laptop waking from sleep
// re-reads at the next beat instead of firing a backlog.

export const USAGE_ALERT_POLL_MS = 30 * 60_000

export type UsageAlertRefreshScheduler = {
  /** A cloud workspace was just created or woken: re-read billing now. */
  noteStarted(): void
  /**
   * Called on every lifecycle reconcile with whether any cloud workspace is running. The first
   * `true` starts the 30-minute poll; `false` (last one stopped or slept) stops it.
   */
  setRunning(running: boolean): void
  dispose(): void
}

export function createUsageAlertRefreshScheduler(deps: {
  /** Ask the window to re-read billing (forced). */
  requestRefresh: () => void
  intervalMs?: number
  now?: () => number
}): UsageAlertRefreshScheduler {
  const intervalMs = deps.intervalMs ?? USAGE_ALERT_POLL_MS
  const now = deps.now ?? Date.now
  /** When the poll last read (or started); null while nothing runs. */
  let pollAnchor: number | null = null
  let disposed = false
  const refresh = (): void => {
    try {
      deps.requestRefresh()
    } catch {
      // A missing or closing window must never break the lifecycle path that called us.
    }
  }
  return {
    noteStarted() {
      if (disposed) {
        return
      }
      refresh()
      if (pollAnchor !== null) {
        // A fresh read just happened; the next poll is a full interval away.
        pollAnchor = now()
      }
    },
    setRunning(running) {
      if (disposed || !running) {
        pollAnchor = null
        return
      }
      const at = now()
      if (pollAnchor === null) {
        // The app's launch read or the create/wake read just covered this moment.
        pollAnchor = at
        return
      }
      if (at - pollAnchor >= intervalMs) {
        pollAnchor = at
        refresh()
      }
    },
    dispose() {
      disposed = true
      pollAnchor = null
    }
  }
}
