import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { getCursorAccountStatus } from '../cursor-accounts/status'

export function registerCursorAccountHandlers(store: Pick<Store, 'getSettings'>): void {
  ipcMain.handle('cursorAccounts:getStatus', () =>
    getCursorAccountStatus(() => store.getSettings())
  )
}
