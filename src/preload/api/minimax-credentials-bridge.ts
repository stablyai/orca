import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const minimaxCredentialsApi = {
  getStatus: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:getStatus'),
  saveCookie: (cookie: string): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:saveCookie', cookie),
  clearCookie: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:clearCookie')
} satisfies PreloadApi['minimaxCredentials']
