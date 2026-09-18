import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const zhipuCredentialsApi = {
  getStatus: (): Promise<{ configured: boolean; baseUrl: string | null }> =>
    ipcRenderer.invoke('zhipuCredentials:getStatus'),
  save: (args: {
    baseUrl: string
    authToken: string
  }): Promise<{ configured: boolean; baseUrl: string | null }> =>
    ipcRenderer.invoke('zhipuCredentials:save', args),
  clear: (): Promise<{ configured: boolean; baseUrl: string | null }> =>
    ipcRenderer.invoke('zhipuCredentials:clear'),
  importFromCcSwitch: (): Promise<{
    configured: boolean
    baseUrl: string | null
    importedProviderName: string
  }> => ipcRenderer.invoke('zhipuCredentials:importFromCcSwitch')
} satisfies PreloadApi['zhipuCredentials']
