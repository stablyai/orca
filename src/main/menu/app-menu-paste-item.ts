import { BrowserWindow, Menu } from 'electron'
import { resolveEditMenuTarget } from './edit-menu-focus-target'

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
      // Why: a focused terminal/native-chat pane is not a native editable
      // control, so raw Electron paste cannot know which Orca surface owns it.
      const focusedWindow = BrowserWindow.getFocusedWindow()
      if (focusedWindow) {
        // Why: DevTools or a guest view can own the caret while this window is "focused".
        const editTarget = resolveEditMenuTarget(focusedWindow)
        if (editTarget) {
          editTarget.paste()
          return
        }
        focusedWindow.webContents.send('ui:appMenuPaste')
        return
      }

      // Why: a macOS native panel (open/save, Go to Folder) leaves no focused
      // BrowserWindow, so overriding the paste role would strand Cmd+V as a no-op.
      if (isMac) {
        Menu.sendActionToFirstResponder('paste:')
      }
    }
  }
}
