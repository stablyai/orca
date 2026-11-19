import { app, BrowserWindow } from 'electron'
import { quitProcess } from '../quit/process-quit-request'
import { WILL_QUIT_TEARDOWN_DEADLINE_MS } from '../../../shared/app-lifecycle/shutdown/quit-teardown-deadline'

// EX_SOFTWARE for forced exits; a quit that completes exits normally.
const FATAL_EXIT_CODE = 70
// Bounds the whole fatal shutdown, including any before-quit deferral, so a wedged quit still exits.
const FATAL_QUIT_FALLBACK_MS = WILL_QUIT_TEARDOWN_DEADLINE_MS + 10_000

/** Quit through the normal teardown without renderer prompts; main's state is unknown, so nobody may veto. */
export function quitAfterFatalException(): void {
  setTimeout(() => app.exit(FATAL_EXIT_CODE), FATAL_QUIT_FALLBACK_MS).unref()
  try {
    if (!app.isReady()) {
      app.exit(FATAL_EXIT_CODE)
      return
    }
    quitProcess()
    // Skips the renderer's close confirmation; before-quit set isQuitting, so window-all-closed keeps quitting.
    for (const window of BrowserWindow.getAllWindows()) {
      window.destroy()
    }
  } catch {
    app.exit(FATAL_EXIT_CODE)
  }
}
