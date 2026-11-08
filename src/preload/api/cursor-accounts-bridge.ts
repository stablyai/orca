import { ipcRenderer } from 'electron'
import type { CursorAccountStatus } from '../../shared/rate-limit-types'
import type { CursorSavedAccountsState } from '../../shared/cursor-account-types'
import type { PreloadApi } from '../api-types'

export const cursorAccountsApi = {
  getStatus: (): Promise<CursorAccountStatus> => ipcRenderer.invoke('cursorAccounts:getStatus'),
  list: (): Promise<CursorSavedAccountsState> => ipcRenderer.invoke('cursorAccounts:list'),
  addCurrent: (): Promise<CursorSavedAccountsState> =>
    ipcRenderer.invoke('cursorAccounts:addCurrent'),
  select: (id: string): Promise<CursorSavedAccountsState> =>
    ipcRenderer.invoke('cursorAccounts:select', id),
  remove: (id: string): Promise<CursorSavedAccountsState> =>
    ipcRenderer.invoke('cursorAccounts:remove', id)
} satisfies PreloadApi['cursorAccounts']
