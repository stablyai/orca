import { ipcMain } from 'electron'
import { getCursorAccountStatus } from '../cursor-accounts/status'

export function registerCursorAccountHandlers(): void {
  ipcMain.handle('cursorAccounts:getStatus', () => getCursorAccountStatus())
}
