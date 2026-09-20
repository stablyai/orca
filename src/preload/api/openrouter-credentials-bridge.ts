import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const openrouterCredentialsApi = {
  getStatus: (): Promise<{ configured: boolean; apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('openrouterCredentials:getStatus'),
  saveApiKey: (key: string): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('openrouterCredentials:saveApiKey', key),
  clearApiKey: (): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('openrouterCredentials:clearApiKey')
} satisfies PreloadApi['openrouterCredentials']
