import { ipcMain } from 'electron'
import { refreshGrokAuthSnapshot } from '../rate-limits/grok-auth-snapshot'
import { getGrokAccountStatus } from '../grok-accounts/status'

export function registerGrokAccountHandlers(): void {
  ipcMain.handle('grokAccounts:getStatus', async () => {
    await refreshGrokAuthSnapshot()
    return getGrokAccountStatus()
  })
}
