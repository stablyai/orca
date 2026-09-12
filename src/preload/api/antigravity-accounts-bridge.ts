import { ipcRenderer } from 'electron'
import type { AntigravityAccountStatus } from '../../shared/rate-limit-types'
import type { PreloadApi } from '../api-types'

type ManagedUsage = Awaited<ReturnType<PreloadApi['antigravityAccounts']['getManagedUsage']>>

export const antigravityAccountsApi = {
  getStatus: (): Promise<AntigravityAccountStatus> =>
    ipcRenderer.invoke('antigravityAccounts:getStatus'),
  addAccount: (): Promise<{ ok: boolean; email?: string; error?: string }> =>
    ipcRenderer.invoke('antigravityAccounts:addAccount'),
  removeAccount: (accountId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('antigravityAccounts:removeAccount', accountId),
  getManagedUsage: (): Promise<ManagedUsage> =>
    ipcRenderer.invoke('antigravityAccounts:getManagedUsage')
} satisfies PreloadApi['antigravityAccounts']
