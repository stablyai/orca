import { BrowserWindow, ipcMain, shell } from 'electron'
import type { KeybindingActionId, KeybindingFileSnapshot } from '../../shared/keybindings'
import type { KeybindingService } from '../keybindings/keybinding-service'
import { rebuildAppMenu } from '../menu/register-app-menu'

function broadcastKeybindingsChanged(snapshot: KeybindingFileSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('keybindings:changed', snapshot)
    }
  }
  rebuildAppMenu()
}

export function registerKeybindingHandlers(service: KeybindingService): void {
  ipcMain.handle('keybindings:get', () => service.getSnapshot())

  ipcMain.handle(
    'keybindings:setAction',
    (_event, args: { actionId: KeybindingActionId; bindings: string[] | null }) => {
      const snapshot = service.setActionBindings(args.actionId, args.bindings)
      broadcastKeybindingsChanged(snapshot)
      return snapshot
    }
  )

  ipcMain.handle('keybindings:reload', () => {
    const snapshot = service.reload()
    broadcastKeybindingsChanged(snapshot)
    return snapshot
  })

  ipcMain.handle('keybindings:openFile', async () => {
    const snapshot = service.ensureFile()
    const error = await shell.openPath(snapshot.path)
    if (error) {
      throw new Error(error)
    }
    return snapshot
  })

  ipcMain.handle('keybindings:revealFile', () => {
    const snapshot = service.ensureFile()
    shell.showItemInFolder(snapshot.path)
    return snapshot
  })
}
