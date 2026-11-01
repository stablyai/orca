import { BaseWindow } from 'electron'
import { getDashboardPopoutWindow } from './dashboard-popout-window'
import { getWorkspaceSpaceWindow } from './workspace-space-window'

/** Whether a window stays open after the main window closes, so `window-all-closed` cannot quit. */
export function windowOutlivesMainWindow(mainWindow: BaseWindow): boolean {
  // Main's `closed` handler closes the popout and Space window; Electron closes child windows.
  const closedWithMain = new Set<BaseWindow>([mainWindow])
  for (const window of [getDashboardPopoutWindow(), getWorkspaceSpaceWindow()]) {
    if (window) {
      closedWithMain.add(window)
    }
  }
  const closesWithMain = (window: BaseWindow | null): boolean =>
    window !== null && (closedWithMain.has(window) || closesWithMain(window.getParentWindow()))
  // BaseWindow also lists popup-origin bars; hidden helper windows block `window-all-closed` too.
  return BaseWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && !closesWithMain(window)
  )
}
