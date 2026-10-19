import { app, powerMonitor, type Event } from 'electron'
import { isProcessQuitRequested, markProcessQuitRequested } from './process-quit-request'

/**
 * On macOS, Dock > Quit, Cmd-Q from the app switcher and Activity Monitor's Quit reach before-quit
 * as a native terminate. On a serve host that would drop every paired client (#15537), so an
 * unmarked quit only closes the desktop windows. Signals, supervisors, relaunches and update
 * installs mark their quit first; logout and shutdown mark it through powerMonitor.
 */
export function installServeNativeQuitGuard(deps: {
  platform: NodeJS.Platform
  isQuittingForUpdate: () => boolean
  closeDesktopWindows: () => void
}): void {
  // Why macOS only: elsewhere every before-quit comes from an app.quit() call this code owns.
  if (deps.platform !== 'darwin') {
    return
  }
  // Why: macOS sends logout/shutdown as the same terminate; vetoing it would cancel the logout.
  powerMonitor.on('shutdown', markProcessQuitRequested)
  // Why prepend: veto before the updater guard and before startup listeners begin teardown.
  app.prependListener('before-quit', (event: Event) => {
    if (isProcessQuitRequested() || deps.isQuittingForUpdate()) {
      return
    }
    event.preventDefault()
    deps.closeDesktopWindows()
  })
}
