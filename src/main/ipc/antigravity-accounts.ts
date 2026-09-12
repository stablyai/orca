import { ipcMain } from 'electron'
import { getAntigravityAccountStatus } from '../antigravity-accounts/status'

export function registerAntigravityAccountHandlers(): void {
  ipcMain.handle('antigravityAccounts:getStatus', () => getAntigravityAccountStatus())
}
