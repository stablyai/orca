import { app, BrowserWindow } from 'electron'
import { quitProcess } from '../quit/process-quit-request'
import { WILL_QUIT_TEARDOWN_DEADLINE_MS } from '../../../shared/app-lifecycle/shutdown/quit-teardown-deadline'

// EX_SOFTWARE: launchers and supervisors can tell a fault from a user quit.
const FATAL_EXIT_CODE = 70
// Outlasts the bounded will-quit teardown so only a wedged quit is cut short.
const FATAL_QUIT_FALLBACK_MS = WILL_QUIT_TEARDOWN_DEADLINE_MS + 10_000

function armFallbackExit(): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => app.exit(FATAL_EXIT_CODE), FATAL_QUIT_FALLBACK_MS)
  timer.unref()
  return timer
}

/** Quit through the normal teardown without renderer prompts; main's state is unknown, so nobody may veto. */
export function quitAfterFatalException(): void {
  // Armed first so a quit that throws, wedges or stays vetoed still exits.
  let fallback = armFallbackExit()
  try {
    if (!app.isReady()) {
      app.exit(FATAL_EXIT_CODE)
      return
    }
    // Registered after Orca's will-quit teardown: a prevented pass means teardown just started, the final pass is unprevented.
    app.on('will-quit', (event) => {
      if (event.defaultPrevented) {
        // A before-quit deferral (e.g. a pending macOS update) must not eat teardown's own bound.
        clearTimeout(fallback)
        fallback = armFallbackExit()
        return
      }
      app.exit(FATAL_EXIT_CODE)
    })
    quitProcess()
    // Skips the renderer's close confirmation; before-quit already set isQuitting, so window-all-closed keeps quitting.
    for (const window of BrowserWindow.getAllWindows()) {
      window.destroy()
    }
  } catch {
    app.exit(FATAL_EXIT_CODE)
  }
}
