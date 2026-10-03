import { ipcRenderer } from 'electron'
import type { GrokAccountStatus } from '../../shared/rate-limit-types'
import type { PreloadApi } from '../api-types'

export const grokAccountsApi = {
  getStatus: (): Promise<GrokAccountStatus> => ipcRenderer.invoke('grokAccounts:getStatus'),
  list: () => ipcRenderer.invoke('grokAccounts:list'),
  add: () => ipcRenderer.invoke('grokAccounts:add'),
  reauthenticate: (accountId: string) =>
    ipcRenderer.invoke('grokAccounts:reauthenticate', { accountId }),
  select: (accountId: string | null) => ipcRenderer.invoke('grokAccounts:select', { accountId }),
  cancelLogin: () => ipcRenderer.invoke('grokAccounts:cancelLogin')
} satisfies PreloadApi['grokAccounts']
