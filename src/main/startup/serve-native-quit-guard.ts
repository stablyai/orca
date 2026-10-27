import { app, powerMonitor, type Event } from 'electron'
import { isProcessQuitRequested, markProcessQuitRequested } from './process-quit-request'

/** macOS native Quit must close serve windows without disconnecting paired clients (#15537). Signals/supervisor/updates mark process quit; shutdown/logout do too so they remain allowed. */
export function installServeNativeQuitGuard(deps: {
  platform: NodeJS.Platform
  isQuittingForUpdate: () => boolean
  closeDesktopWindows: () => void
}): void {
  // Only macOS delivers native termination outside our owned app.quit calls.
  if (deps.platform !== 'darwin') {
    return
  }
  // Native logout/shutdown uses the same terminate path; allow it or logout is canceled.
  powerMonitor.on('shutdown', markProcessQuitRequested)
  // Veto before updater/startup listeners begin teardown.
  app.prependListener('before-quit', (event: Event) => {
    if (isProcessQuitRequested() || deps.isQuittingForUpdate()) {
      return
    }
    event.preventDefault()
    deps.closeDesktopWindows()
  })
}
