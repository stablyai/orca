import { ipcMain } from 'electron'
import type { KeybindingSnapshot } from '../../shared/keybindings/keybinding-types'

export type KeybindingIpcService = {
  getSnapshot: () => KeybindingSnapshot
  reload: () => KeybindingSnapshot
  openConfig: () => Promise<void> | void
  revealConfig: () => Promise<void> | void
}

export function registerKeybindingHandlers(service: KeybindingIpcService): void {
  ipcMain.handle('keybindings:getSnapshot', () => service.getSnapshot())
  ipcMain.handle('keybindings:reload', (event) => {
    const snapshot = service.reload()
    event.sender.send('keybindings:changed', snapshot)
    return snapshot
  })
  ipcMain.handle('keybindings:openConfig', () => service.openConfig())
  ipcMain.handle('keybindings:revealConfig', () => service.revealConfig())
}
