import { ipcMain } from 'electron'
import { clearFactoryApiKey, saveFactoryApiKey } from '../factory/factory-api-key-store'
import { getFactoryAccountStatus } from '../factory-accounts/status'
import type { RateLimitService } from '../rate-limits/service'

// Why: fire-and-forget — callers get the persisted key status immediately;
// the rate-limit refresh runs in the background and only logs on failure.
function refreshAfterFactoryCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  rateLimits?.invalidateFactoryCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[factory] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerFactoryAccountHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('factoryAccounts:getStatus', () => getFactoryAccountStatus())
  ipcMain.handle('factoryAccounts:saveApiKey', (_event, apiKey: string) => {
    // Validate the IPC argument in the main process; the renderer-declared type
    // is compile-time only and the value arrives as unknown over IPC.
    if (typeof apiKey !== 'string') {
      throw new Error('Factory API key must be a string')
    }
    saveFactoryApiKey(apiKey)
    refreshAfterFactoryCredentialChange(rateLimits, 'save')
    return getFactoryAccountStatus()
  })
  ipcMain.handle('factoryAccounts:clearApiKey', () => {
    clearFactoryApiKey()
    refreshAfterFactoryCredentialChange(rateLimits, 'clear')
    return getFactoryAccountStatus()
  })
}
