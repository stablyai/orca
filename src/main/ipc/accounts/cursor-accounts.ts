import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { getCursorAccountStatus } from '../../cursor-accounts/status'

export function registerCursorAccountHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  ipc.handle('cursorAccounts:getStatus', () => getCursorAccountStatus())
}
