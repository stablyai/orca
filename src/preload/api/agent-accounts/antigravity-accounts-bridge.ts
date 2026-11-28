import { ipcRenderer } from 'electron'
import type { AntigravityAccountSelectionChange } from '../../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { AntigravityAccountsApi } from './agent-account-api'

export const antigravityAccountsApi = {
  onSelectedElsewhere: (callback: (change: AntigravityAccountSelectionChange) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      change: AntigravityAccountSelectionChange
    ) => callback(change)
    ipcRenderer.on('antigravityAccounts:selectedElsewhere', listener)
    return () => ipcRenderer.removeListener('antigravityAccounts:selectedElsewhere', listener)
  }
} satisfies AntigravityAccountsApi
