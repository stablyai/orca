import { ipcMain } from 'electron'
import {
  clearOllamaCloudApiKeyCredential,
  getOllamaCloudCredentialsStatus,
  saveOllamaCloudApiKeyCredential
} from '../ollama/ollama-cloud-credential-commands'
import type { RateLimitService } from '../rate-limits/service'

export function registerOllamaCloudCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('ollamaCloudCredentials:getStatus', () => getOllamaCloudCredentialsStatus())
  ipcMain.handle('ollamaCloudCredentials:saveApiKey', (_event, key: unknown) =>
    saveOllamaCloudApiKeyCredential(rateLimits, key)
  )
  ipcMain.handle('ollamaCloudCredentials:clearApiKey', () =>
    clearOllamaCloudApiKeyCredential(rateLimits)
  )
}
