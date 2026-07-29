import { ipcMain } from 'electron'
import { getGrokAccountStatus } from '../grok-accounts/status'

export function registerGrokAccountHandlers(): void {
  ipcMain.handle('grokAccounts:getStatus', () => getGrokAccountStatus())
}
