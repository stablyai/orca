import { ipcRenderer } from 'electron'
import type { GrokAccountStatus } from '../../shared/rate-limit-types'

export const grokAccountsApi = {
  getStatus: (): Promise<GrokAccountStatus> => ipcRenderer.invoke('grokAccounts:getStatus')
}
