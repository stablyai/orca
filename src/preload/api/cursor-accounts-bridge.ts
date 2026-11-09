import { ipcRenderer } from 'electron'
import type { CursorAccountStatus } from '../../shared/rate-limit-types'
import type { PreloadApi } from '../api-types'

export const cursorAccountsApi = {
  getStatus: (): Promise<CursorAccountStatus> => ipcRenderer.invoke('cursorAccounts:getStatus')
} satisfies PreloadApi['cursorAccounts']
