import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'

export const minimaxCredentialsApi = {
  getStatus: (): Promise<{
    configured: boolean
    cookieConfigured: boolean
    apiKeyConfigured: boolean
    cookieProtection: SecretAtRestProtection | null
    apiKeyProtection: SecretAtRestProtection | null
  }> => ipcRenderer.invoke('minimaxCredentials:getStatus'),
  saveCookie: (
    cookie: string
  ): Promise<{ cookieConfigured: boolean; cookieProtection: SecretAtRestProtection | null }> =>
    ipcRenderer.invoke('minimaxCredentials:saveCookie', cookie),
  clearCookie: (): Promise<{
    cookieConfigured: boolean
    cookieProtection: SecretAtRestProtection | null
  }> => ipcRenderer.invoke('minimaxCredentials:clearCookie'),
  saveApiKey: (
    key: string
  ): Promise<{ apiKeyConfigured: boolean; apiKeyProtection: SecretAtRestProtection | null }> =>
    ipcRenderer.invoke('minimaxCredentials:saveApiKey', key),
  clearApiKey: (): Promise<{
    apiKeyConfigured: boolean
    apiKeyProtection: SecretAtRestProtection | null
  }> => ipcRenderer.invoke('minimaxCredentials:clearApiKey')
} satisfies PreloadApi['minimaxCredentials']
