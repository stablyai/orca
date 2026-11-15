import { ipcMain } from 'electron'
import { getCursorAccountStatus } from '../cursor-accounts/status'
import {
  addCurrentCursorAccount,
  listCursorAccounts,
  removeCursorAccount,
  selectCursorAccount
} from '../cursor-accounts/cursor-account-host'

export function registerCursorAccountHandlers(): void {
  ipcMain.handle('cursorAccounts:getStatus', () => getCursorAccountStatus())
  ipcMain.handle('cursorAccounts:list', () => listCursorAccounts())
  ipcMain.handle('cursorAccounts:addCurrent', () => addCurrentCursorAccount())
  ipcMain.handle('cursorAccounts:select', (_event, id: string) => selectCursorAccount(id))
  ipcMain.handle('cursorAccounts:remove', (_event, id: string) => removeCursorAccount(id))
}
