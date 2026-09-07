import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const minimaxCredentialsApi = {
  getStatus: (): Promise<{
    configured: boolean
    cookieConfigured: boolean
    apiKeyConfigured: boolean
  }> => ipcRenderer.invoke('minimaxCredentials:getStatus'),
  saveCookie: (cookie: string): Promise<{ cookieConfigured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:saveCookie', cookie),
  clearCookie: (): Promise<{ cookieConfigured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:clearCookie'),
  saveApiKey: (key: string): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:saveApiKey', key),
  clearApiKey: (): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:clearApiKey')
} satisfies PreloadApi['minimaxCredentials']
