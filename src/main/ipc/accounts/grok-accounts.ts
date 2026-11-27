import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { getGrokAccountStatus } from '../../grok-accounts/status'

export function registerGrokAccountHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  ipc.handle('grokAccounts:getStatus', () => getGrokAccountStatus())
}
