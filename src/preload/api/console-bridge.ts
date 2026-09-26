import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const consoleApi = {
  setCredential: (apiKey: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('consoleCredentials:setCredential', apiKey),
  getCredential: (): Promise<{ apiKey?: string | null; error?: string }> =>
    ipcRenderer.invoke('consoleCredentials:getCredential'),
  clearCredential: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('consoleCredentials:clearCredential')
} satisfies PreloadApi['console']
