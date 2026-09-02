import { ipcRenderer } from 'electron'

export const codexAccountsApi = {
  list: (): Promise<unknown> => ipcRenderer.invoke('codexAccounts:list'),
  add: (args?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }): Promise<unknown> =>
    ipcRenderer.invoke('codexAccounts:add', args),
  reauthenticate: (args: {
    accountId: string
    activateIfSelectionWasEmpty?: boolean
  }): Promise<unknown> => ipcRenderer.invoke('codexAccounts:reauthenticate', args),
  remove: (args: { accountId: string }): Promise<unknown> =>
    ipcRenderer.invoke('codexAccounts:remove', args),
  select: (args: {
    accountId: string | null
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }): Promise<unknown> => ipcRenderer.invoke('codexAccounts:select', args),
  listStalePanes: (args: {
    ptyIds: string[]
  }): Promise<
    {
      ptyId: string
      launchAccountId: string | null
      activeAccountId: string | null
      reason?: 'account-change' | 'home-route-change'
    }[]
  > => ipcRenderer.invoke('codexAccounts:listStalePanes', args),
  listRecordedPaneLanes: (args: { ptyIds: string[] }): Promise<Record<string, string>> =>
    ipcRenderer.invoke('codexAccounts:listRecordedPaneLanes', args),
  forgetStalePanes: (args: { ptyIds: string[] }): Promise<void> =>
    ipcRenderer.invoke('codexAccounts:forgetStalePanes', args)
}
