import { app } from 'electron'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'

// Why 20s: comfortably above a healthy shutdown (renderer buffer capture,
// daemon final checkpoints, bounded 2s telemetry flush) but bounded — a wedged
// teardown otherwise keeps the old process alive forever and the installer
// never replaces the bundle or relaunches (issue #4438).
export const UPDATE_INSTALL_EXIT_TIMEOUT_MS = 20_000

let exitTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Guarantee the old app process exits once an update install has committed.
 *
 * Squirrel's ShipIt on macOS (and the Win/Linux installers) wait for the old
 * app process to exit before installing the staged update and relaunching.
 * The normal quit path defers exit behind unbounded async teardown — daemon
 * checkpoint RPCs (30s timeout each, per session), SSH disconnects, watcher
 * and emulator shutdown. If any of those wedge, the app looks closed (windows
 * gone) but the process survives, ShipIt stalls, and the update never applies.
 * Once armed, the process force-exits after the deadline if it is still alive.
 */
export function armUpdateInstallExitWatchdog(timeoutMs = UPDATE_INSTALL_EXIT_TIMEOUT_MS): void {
  if (exitTimer) {
    return
  }
  exitTimer = setTimeout(() => {
    recordUpdaterLifecycle(
      'install_exit_watchdog_fired',
      { timeoutMs },
      {
        level: 'warn',
        message: `Shutdown did not finish within ${timeoutMs}ms of committing the update install; forcing exit so the installer can relaunch`
      }
    )
    // Why exit(0): the quit is already committed and cleanup is wedged, not
    // failed — a clean code keeps ShipIt/launchd on the normal relaunch path.
    app.exit(0)
  }, timeoutMs)
  // Why unref: the watchdog must never be the thing keeping the process alive.
  exitTimer.unref?.()
}

/** Cancel the watchdog when install recovery re-opens the app (pre-commit
 * native errors on macOS reset quit state and keep the session running). */
export function disarmUpdateInstallExitWatchdog(): void {
  if (exitTimer) {
    clearTimeout(exitTimer)
    exitTimer = null
  }
}
