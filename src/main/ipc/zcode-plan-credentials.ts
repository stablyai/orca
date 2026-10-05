import { ipcMain } from 'electron'
import {
  clearZcodePlanApiKey,
  getZcodePlanApiKeyProtection,
  hasZcodePlanApiKey,
  saveZcodePlanApiKey
} from '../zcode/zcode-plan-api-key-store'
import { hasZcodeCliPlanCredentials } from '../rate-limits/zcode-usage-fetcher'
import type { RateLimitService } from '../rate-limits/service'
import type { ZcodePlanCredentialsStatus } from '../../shared/zcode-plan-sites'

function getZcodePlanCredentialsStatus(): ZcodePlanCredentialsStatus {
  return {
    apiKeyConfigured: hasZcodePlanApiKey(),
    zcodeCliConfigured: hasZcodeCliPlanCredentials(),
    apiKeyProtection: getZcodePlanApiKeyProtection()
  }
}

// Why: fire-and-forget — callers get the persisted credential status immediately;
// the rate-limit refresh runs in the background and only logs on failure.
function refreshAfterZcodePlanCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  rateLimits?.invalidateZcodeCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[zcode] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerZcodePlanCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('zcodePlanCredentials:getStatus', () => getZcodePlanCredentialsStatus())
  ipcMain.handle('zcodePlanCredentials:saveApiKey', (_event, key: string) => {
    // Validate the IPC argument in the main process; the renderer-declared type
    // is compile-time only and the value arrives as unknown over IPC.
    if (typeof key !== 'string') {
      throw new Error('GLM Coding Plan API key must be a string')
    }
    saveZcodePlanApiKey(key)
    refreshAfterZcodePlanCredentialChange(rateLimits, 'save')
    return getZcodePlanCredentialsStatus()
  })
  ipcMain.handle('zcodePlanCredentials:clearApiKey', () => {
    clearZcodePlanApiKey()
    refreshAfterZcodePlanCredentialChange(rateLimits, 'clear')
    return getZcodePlanCredentialsStatus()
  })
}
