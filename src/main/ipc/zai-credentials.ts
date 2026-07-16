import { ipcMain } from 'electron'
import { clearZaiApiKey, hasZaiApiKey, saveZaiApiKey } from '../zai/zai-api-key-store'
import type { RateLimitService } from '../rate-limits/service'
import { validateZaiApiKey } from '../zai/zai-api-key-validation'

export type ZaiCredentialsStatus = {
  configured: boolean
}

function getZaiCredentialsStatus(): ZaiCredentialsStatus {
  return { configured: hasZaiApiKey() }
}

function refreshAfterZaiCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  rateLimits?.invalidateZaiCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[zai] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerZaiCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('zaiCredentials:getStatus', () => getZaiCredentialsStatus())
  ipcMain.handle('zaiCredentials:saveApiKey', (_event, apiKey: string) => {
    if (typeof apiKey !== 'string') {
      throw new Error('Z.ai API key must be a string')
    }
    saveZaiApiKey(validateZaiApiKey(apiKey))
    refreshAfterZaiCredentialChange(rateLimits, 'save')
    return getZaiCredentialsStatus()
  })
  ipcMain.handle('zaiCredentials:clearApiKey', () => {
    clearZaiApiKey()
    refreshAfterZaiCredentialChange(rateLimits, 'clear')
    return getZaiCredentialsStatus()
  })
}
