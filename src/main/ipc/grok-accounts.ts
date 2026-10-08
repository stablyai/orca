import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { getGrokAccountStatus } from '../grok-accounts/status'

export function registerGrokAccountHandlers(store: Pick<Store, 'getSettings'>): void {
  ipcMain.handle('grokAccounts:getStatus', () => getGrokAccountStatus(store.getSettings()))
}
