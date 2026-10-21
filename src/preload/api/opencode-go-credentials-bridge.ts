import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const opencodeGoCredentialsApi = {
  getStatus: (): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('opencodeGoCredentials:getStatus'),
  saveApiKey: (key: string): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('opencodeGoCredentials:saveApiKey', key),
  clearApiKey: (): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('opencodeGoCredentials:clearApiKey')
} satisfies PreloadApi['opencodeGoCredentials']
