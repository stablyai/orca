import { ipcMain, shell } from 'electron'
import { hasExternalAppHandler } from '../../external-apps/protocol-handler'

const QWENWORK_DESKTOP_URL = 'qwenwork-cn://'

export function registerQwenWorkDesktopHandoff(): void {
  ipcMain.handle('shell:isQwenWorkAvailable', () => hasExternalAppHandler(QWENWORK_DESKTOP_URL))
  ipcMain.handle('shell:openQwenWork', () => {
    if (!hasExternalAppHandler(QWENWORK_DESKTOP_URL)) {
      throw new Error('QwenWork is unavailable')
    }
    return shell.openExternal(QWENWORK_DESKTOP_URL)
  })
}
