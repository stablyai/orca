import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { MiniMaxCredentialsStatus } from '../../shared/minimax-credentials-status'

export const minimaxCredentialsApi = {
  getStatus: (): Promise<MiniMaxCredentialsStatus> =>
    ipcRenderer.invoke('minimaxCredentials:getStatus'),
  saveCookie: (cookie: string): Promise<MiniMaxCredentialsStatus> =>
    ipcRenderer.invoke('minimaxCredentials:saveCookie', cookie),
  clearCookie: (): Promise<MiniMaxCredentialsStatus> =>
    ipcRenderer.invoke('minimaxCredentials:clearCookie'),
  saveApiKey: (key: string): Promise<MiniMaxCredentialsStatus> =>
    ipcRenderer.invoke('minimaxCredentials:saveApiKey', key),
  clearApiKey: (): Promise<MiniMaxCredentialsStatus> =>
    ipcRenderer.invoke('minimaxCredentials:clearApiKey')
} satisfies PreloadApi['minimaxCredentials']
