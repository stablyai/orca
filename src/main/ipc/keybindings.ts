import { BrowserWindow, ipcMain, shell } from 'electron'
import type { KeybindingActionId, KeybindingFileSnapshot } from '../../shared/keybindings'
import type { KeybindingService } from '../keybindings/keybinding-service'
import { rebuildAppMenu } from '../menu/register-app-menu'

export function broadcastKeybindingsChanged(snapshot: KeybindingFileSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('keybindings:changed', snapshot)
    }
  }
  rebuildAppMenu()
}

export function registerKeybindingHandlers(
  service: KeybindingService,
  onChanged?: () => void
): void {
  ipcMain.handle('keybindings:get', () => service.getSnapshot())

  ipcMain.handle('keybindings:ensureFile', async () => {
    const snapshot = await service.ensureFile()
    broadcastKeybindingsChanged(snapshot)
    onChanged?.()
    return snapshot
  })

  ipcMain.handle(
    'keybindings:setAction',
    async (_event, args: { actionId: KeybindingActionId; bindings: string[] | null }) => {
      const snapshot = await service.setActionBindings(args.actionId, args.bindings)
      broadcastKeybindingsChanged(snapshot)
      onChanged?.()
      return snapshot
    }
  )

  ipcMain.handle('keybindings:reload', async () => {
    const snapshot = await service.reload()
    broadcastKeybindingsChanged(snapshot)
    onChanged?.()
    return snapshot
  })

  ipcMain.handle('keybindings:openFile', async () => {
    const snapshot = await service.ensureFile()
    const error = await shell.openPath(snapshot.path)
    if (error) {
      throw new Error(error)
    }
    return snapshot
  })

  ipcMain.handle('keybindings:revealFile', async () => {
    const snapshot = await service.ensureFile()
    shell.showItemInFolder(snapshot.path)
    return snapshot
  })
}
