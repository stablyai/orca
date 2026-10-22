import { ipcMain } from 'electron'
import { getMuseAccountStatus } from '../muse-accounts/status'

export function registerMuseAccountHandlers(): void {
  ipcMain.handle('museAccounts:getStatus', () => getMuseAccountStatus())
}
