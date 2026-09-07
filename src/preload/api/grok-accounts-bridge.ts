import { ipcRenderer } from 'electron'
import type { GrokAccountStatus } from '../../shared/rate-limit-types'
import type { PreloadApi } from '../api-types'

export const grokAccountsApi = {
  getStatus: (): Promise<GrokAccountStatus> => ipcRenderer.invoke('grokAccounts:getStatus')
} satisfies PreloadApi['grokAccounts']
