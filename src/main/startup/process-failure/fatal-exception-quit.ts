import { app, BrowserWindow } from 'electron'
import { quitProcess } from '../quit/process-quit-request'
import { WILL_QUIT_TEARDOWN_DEADLINE_MS } from '../../../shared/app-lifecycle/shutdown/quit-teardown-deadline'

// EX_SOFTWARE: launchers and supervisors can tell a fault from a user quit.
const FATAL_EXIT_CODE = 70
// Outlasts the bounded will-quit teardown so only a wedged quit is cut short.
const FATAL_QUIT_FALLBACK_MS = WILL_QUIT_TEARDOWN_DEADLINE_MS + 10_000

/** Quit through the normal teardown without renderer prompts; main's state is unknown, so nobody may veto. */
export function quitAfterFatalException(): void {
  // Armed first so a quit that throws or wedges still exits.
  setTimeout(() => app.exit(FATAL_EXIT_CODE), FATAL_QUIT_FALLBACK_MS).unref()
  try {
    if (!app.isReady()) {
      app.exit(FATAL_EXIT_CODE)
      return
    }
    // Later will-quit listeners only see the final pass; earlier ones prevent default while teardown runs.
    app.on('will-quit', (event) => {
      if (!event.defaultPrevented) {
        app.exit(FATAL_EXIT_CODE)
      }
    })
    quitProcess()
    // After quit starts, so destroyed windows continue the quit instead of re-entering window-all-closed policy.
    for (const window of BrowserWindow.getAllWindows()) {
      window.destroy()
    }
  } catch {
    app.exit(FATAL_EXIT_CODE)
  }
}
