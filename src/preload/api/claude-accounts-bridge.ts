import { ipcRenderer } from 'electron'
import type { ClaudeAccountSelectionChange } from '../../shared/managed-account-types'
import type { PreloadApi } from '../api-types'
import type {
  ClaudeAutoSwitchedEvent,
  ClaudePaneAssignedEvent
} from '../../shared/managed-account-types'

export const claudeAccountsApi = {
  list: () => ipcRenderer.invoke('claudeAccounts:list'),
  add: (args?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null; copyLink?: boolean }) =>
    ipcRenderer.invoke('claudeAccounts:add', args),
  cancelPendingLogin: (): Promise<boolean> =>
    ipcRenderer.invoke('claudeAccounts:cancelPendingLogin'),
  reauthenticate: (args: { accountId: string; copyLink?: boolean }) =>
    ipcRenderer.invoke('claudeAccounts:reauthenticate', args),
  waitForSignInLink: (): Promise<string | null> =>
    ipcRenderer.invoke('claudeAccounts:waitForSignInLink'),
  remove: (args: { accountId: string }) => ipcRenderer.invoke('claudeAccounts:remove', args),
  select: (args: {
    accountId: string | null
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }) => ipcRenderer.invoke('claudeAccounts:select', args),
  onSelectedElsewhere: (callback: (change: ClaudeAccountSelectionChange) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, change: ClaudeAccountSelectionChange) =>
      callback(change)
    ipcRenderer.on('claudeAccounts:selectedElsewhere', listener)
    return () => ipcRenderer.removeListener('claudeAccounts:selectedElsewhere', listener)
  },
  setAutoSwitch: (args: { enabled: boolean }) =>
    ipcRenderer.invoke('claudeAccounts:setAutoSwitch', args),
  onAutoSwitched: (callback: (switched: ClaudeAutoSwitchedEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, switched: ClaudeAutoSwitchedEvent) =>
      callback(switched)
    ipcRenderer.on('claudeAccounts:autoSwitched', listener)
    return () => ipcRenderer.removeListener('claudeAccounts:autoSwitched', listener)
  },
  onPaneAssigned: (callback: (assigned: ClaudePaneAssignedEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, assigned: ClaudePaneAssignedEvent) =>
      callback(assigned)
    ipcRenderer.on('claudeAccounts:paneAssigned', listener)
    return () => ipcRenderer.removeListener('claudeAccounts:paneAssigned', listener)
  }
} satisfies PreloadApi['claudeAccounts']
