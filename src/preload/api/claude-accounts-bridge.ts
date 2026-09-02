import { ipcRenderer } from 'electron'

export const claudeAccountsApi = {
  list: (): Promise<unknown> => ipcRenderer.invoke('claudeAccounts:list'),
  add: (args?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }): Promise<unknown> =>
    ipcRenderer.invoke('claudeAccounts:add', args),
  cancelPendingLogin: (): Promise<boolean> =>
    ipcRenderer.invoke('claudeAccounts:cancelPendingLogin'),
  reauthenticate: (args: { accountId: string }): Promise<unknown> =>
    ipcRenderer.invoke('claudeAccounts:reauthenticate', args),
  remove: (args: { accountId: string }): Promise<unknown> =>
    ipcRenderer.invoke('claudeAccounts:remove', args),
  select: (args: {
    accountId: string | null
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }): Promise<unknown> => ipcRenderer.invoke('claudeAccounts:select', args)
}
