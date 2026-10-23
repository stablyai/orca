import { BrowserWindow, Menu, webContents } from 'electron'
import { isNativeBrowserPopupWindow } from '../browser/native-browser-popup-windows'

export type AppMenuSelectionAction = 'copy' | 'select-all'

/**
 * The contents that should run a native Edit action itself: DevTools, a browser page or a native
 * popup holding focus. Null when the window's own renderer has focus, where Orca owns the action.
 */
export function resolveNativeEditTarget(
  focusedWindow: Electron.BrowserWindow
): Electron.WebContents | null {
  const focusedContents = webContents.getFocusedWebContents() ?? focusedWindow.webContents
  return isNativeBrowserPopupWindow(focusedWindow) || focusedContents !== focusedWindow.webContents
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
