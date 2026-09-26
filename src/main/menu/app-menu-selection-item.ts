import { BrowserWindow, Menu, webContents } from 'electron'

export type AppMenuSelectionAction = 'copy' | 'select-all'

/** Why: routes copy/select-all through IPC when a window is focused (so a
 *  custom Orca surface like a terminal or native-chat pane can own the
 *  action), and falls back to the native first-responder command otherwise. */
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
        const focusedContents = webContents.getFocusedWebContents()
        if (focusedContents && focusedContents !== focusedWindow.webContents) {
          if (action === 'copy') {
            focusedContents.copy()
          } else {
            focusedContents.selectAll()
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

/** Why: a focused terminal/native-chat pane is not a native editable control,
 *  so raw Electron paste cannot know which Orca surface owns it - route
 *  through IPC when a window is focused, and fall back to the native
 *  first-responder paste for macOS panels (open/save, Go to Folder) that
 *  leave no focused BrowserWindow. */
export function createAppMenuPasteItem({
  label,
  isMac
}: {
  label: string
  isMac: boolean
}): Electron.MenuItemConstructorOptions {
  return {
    label,
    accelerator: 'CmdOrCtrl+V',
    click: () => {
      const focusedWindow = BrowserWindow.getFocusedWindow()
      if (focusedWindow) {
        focusedWindow.webContents.send('ui:appMenuPaste')
        return
      }
      if (isMac) {
        Menu.sendActionToFirstResponder('paste:')
      }
    }
  }
}
