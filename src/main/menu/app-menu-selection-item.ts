import { BrowserWindow, Menu } from 'electron'
import { resolveEditMenuTarget } from './edit-menu-focus-target'

export type AppMenuSelectionAction = 'copy' | 'select-all'

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
        const editTarget = resolveEditMenuTarget(focusedWindow)
        if (editTarget) {
          if (action === 'copy') {
            editTarget.copy()
          } else {
            editTarget.selectAll()
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
