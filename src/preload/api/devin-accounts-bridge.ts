import { ipcRenderer } from 'electron'
import type { DevinAccountStatus } from '../../shared/rate-limit-types'
import type { PreloadApi } from '../api-types'

export const devinAccountsApi = {
  getStatus: (): Promise<DevinAccountStatus> => ipcRenderer.invoke('devinAccounts:getStatus')
} satisfies PreloadApi['devinAccounts']
