import { ipcRenderer } from 'electron'
import type { MuseAccountStatus } from '../../shared/rate-limit-types'
import type { PreloadApi } from '../api-types'

export const museAccountsApi = {
  getStatus: (): Promise<MuseAccountStatus> => ipcRenderer.invoke('museAccounts:getStatus')
} satisfies PreloadApi['museAccounts']
