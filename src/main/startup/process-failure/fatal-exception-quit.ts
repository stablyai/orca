import { app, BrowserWindow } from 'electron'
import { quitProcess } from '../quit/process-quit-request'

// EX_SOFTWARE for forced exits; a quit that completes exits normally.
const FATAL_EXIT_CODE = 70
// Fatal quits measured under 1 s; short, with headroom for slow disks, so a wedged quit still exits.
const FATAL_QUIT_FALLBACK_MS = 5_000

/** Quit through the normal teardown without renderer prompts; main's state is unknown, so nobody may veto. */
export function quitAfterFatalException(): void {
  setTimeout(() => app.exit(FATAL_EXIT_CODE), FATAL_QUIT_FALLBACK_MS).unref()
  try {
    if (!app.isReady()) {
      app.exit(FATAL_EXIT_CODE)
      return
    }
    quitProcess()
    // Skips the renderer's close confirmation and its unload save; window-all-closed keeps quitting via isQuitting.
    for (const window of BrowserWindow.getAllWindows()) {
      window.destroy()
    }
  } catch {
    app.exit(FATAL_EXIT_CODE)
  }
}
