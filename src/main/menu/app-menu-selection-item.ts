import { BrowserWindow, Menu, webContents } from 'electron'
import { isNativeBrowserPopupWindow } from '../browser/native-browser-popup-windows'
import { isWorkerWindowRenderer } from '../window/worker-window'

export type AppMenuSelectionAction = 'copy' | 'select-all'

/** Workers have no menu IPC bridge; host renderer surfaces keep Orca's terminal routing. */
export function resolveNativeEditTarget(
  focusedWindow: Electron.BrowserWindow
): Electron.WebContents | null {
  const focusedContents = webContents.getFocusedWebContents() ?? focusedWindow.webContents
  return isNativeBrowserPopupWindow(focusedWindow) ||
    isWorkerWindowRenderer(focusedWindow.webContents) ||
    focusedContents !== focusedWindow.webContents
    ? focusedContents
    : null
}

export function createAppMenuSelectionItem({
  action,
  label,
  isMac
}: {
  action: AppMenuSelectionAction
  label: string
  isMac: boolean
}): Electron.MenuItemConstructorOptions {
  return {
    label,
    ...(isMac ? { accelerator: action === 'copy' ? 'Command+C' : 'Command+A' } : {}),
    click: () => {
      const focusedWindow = BrowserWindow.getFocusedWindow()
      if (focusedWindow) {
        const nativeTarget = resolveNativeEditTarget(focusedWindow)
        if (nativeTarget) {
          if (action === 'copy') {
            nativeTarget.copy()
          } else {
            nativeTarget.selectAll()
          }
          return
        }
        focusedWindow.webContents.send('ui:appMenuSelectionAction', action)
        return
      }
      if (isMac) {
        Menu.sendActionToFirstResponder(action === 'copy' ? 'copy:' : 'selectAll:')
      }
    }
  }
}
