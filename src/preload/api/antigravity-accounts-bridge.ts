import { ipcRenderer } from 'electron'
import type { AntigravityAccountStatus } from '../../shared/rate-limit-types'
import type { PreloadApi } from '../api-types'

export const antigravityAccountsApi = {
  getStatus: (): Promise<AntigravityAccountStatus> =>
    ipcRenderer.invoke('antigravityAccounts:getStatus')
} satisfies PreloadApi['antigravityAccounts']
