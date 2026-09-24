import { ipcRenderer } from 'electron'
import { CODEX_PENDING_LOGIN_URL_CHANGED_CHANNEL } from '../../shared/codex-auth-errors'
import type { PreloadApi } from '../api-types'

export const codexAccountsApi = {
  list: () => ipcRenderer.invoke('codexAccounts:list'),
  add: (args?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }) =>
    ipcRenderer.invoke('codexAccounts:add', args),
  cancelPendingLogin: (): Promise<boolean> =>
    ipcRenderer.invoke('codexAccounts:cancelPendingLogin'),
  getPendingLoginUrl: (): Promise<string | null> =>
    ipcRenderer.invoke('codexAccounts:pendingLoginUrl'),
  onPendingLoginUrlChanged: (callback: (url: string | null) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string | null): void => callback(url)
    ipcRenderer.on(CODEX_PENDING_LOGIN_URL_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(CODEX_PENDING_LOGIN_URL_CHANGED_CHANNEL, listener)
  },
  reauthenticate: (args: { accountId: string; activateIfSelectionWasEmpty?: boolean }) =>
    ipcRenderer.invoke('codexAccounts:reauthenticate', args),
  remove: (args: { accountId: string }) => ipcRenderer.invoke('codexAccounts:remove', args),
  select: (args: {
    accountId: string | null
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }) => ipcRenderer.invoke('codexAccounts:select', args),
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
} satisfies PreloadApi['codexAccounts']
