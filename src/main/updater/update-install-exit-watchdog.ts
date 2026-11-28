import { app } from 'electron'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'
import { recordAgentSessionRuntimeEnd } from '../runtime/agent-session/records/agent-session-runtime-end-record'

// Leave time for normal checkpoints, but do not strand the installer behind a wedged shutdown.
export const UPDATE_INSTALL_EXIT_TIMEOUT_MS = 20_000
// Windows' installer terminates install-folder processes after ORCA_UPDATE_EXIT_GRACE_MS (10 s,
// config/nsis/orca-process-check.nsh); exit on our own first rather than be killed mid-write.
export const WINDOWS_UPDATE_INSTALL_EXIT_TIMEOUT_MS = 8_000

export function updateInstallExitTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32'
    ? WINDOWS_UPDATE_INSTALL_EXIT_TIMEOUT_MS
    : UPDATE_INSTALL_EXIT_TIMEOUT_MS
}

let exitTimer: ReturnType<typeof setTimeout> | null = null

export function armUpdateInstallExitWatchdog(timeoutMs = updateInstallExitTimeoutMs()): void {
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
    // Exit successfully so ShipIt/launchd can follow the normal relaunch path.
    recordAgentSessionRuntimeEnd('update')
    app.exit(0)
  }, timeoutMs)
  exitTimer.unref?.()
}

// Recovery resumes the app; an armed watchdog would kill the restored session.
export function disarmUpdateInstallExitWatchdog(): void {
  if (exitTimer) {
    clearTimeout(exitTimer)
    exitTimer = null
  }
}
