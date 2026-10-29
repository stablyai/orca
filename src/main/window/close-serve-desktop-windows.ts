import type { BrowserWindow } from 'electron'
import { safelyRevealWindow } from './focus-existing-window'
import { markUserQuitWindowClose } from './user-quit-window-close'
import {
  closeWorkerWindowsForUserQuit,
  forgetRetainedHostWindow,
  getWorkerWindows
} from './worker-window'

let closeInFlight = false

/** Keep the authoritative host until every worker has accepted its close. */
export function closeServeDesktopWindows(
  mainWindow: BrowserWindow | null,
  dashboardWindow: BrowserWindow | null
): void {
  if (closeInFlight) {
    return
  }
  const closeHostWindows = (): void => {
    for (const window of [mainWindow, dashboardWindow]) {
      if (window && !window.isDestroyed()) {
        if (window === mainWindow) {
          markUserQuitWindowClose(window)
        }
        window.close()
      }
    }
  }
  if (getWorkerWindows().length === 0) {
    closeHostWindows()
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    forgetRetainedHostWindow(mainWindow)
    safelyRevealWindow(mainWindow)
  }
  closeInFlight = true
  void closeWorkerWindowsForUserQuit()
    .then((closed) => {
      if (closed) {
        closeHostWindows()
      }
    })
    .finally(() => {
      closeInFlight = false
    })
}
