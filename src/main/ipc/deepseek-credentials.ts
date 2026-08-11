import { ipcMain } from 'electron'
import {
  clearDeepSeekApiKey,
  hasDeepSeekApiKey,
  saveDeepSeekApiKey
} from '../deepseek/deepseek-api-key-store'
import type { RateLimitService } from '../rate-limits/service'

export type DeepSeekCredentialsStatus = {
  configured: boolean
}

function getStatus(): DeepSeekCredentialsStatus {
  return { configured: hasDeepSeekApiKey() }
}

// Why: fire-and-forget — the caller gets the persisted status immediately; the
// rate-limit refresh recomputes DeepSeek auth + balance in the background.
function refreshAfterChange(rateLimits: RateLimitService | null, action: 'save' | 'clear'): void {
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[deepseek] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerDeepSeekCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('deepseekCredentials:getStatus', () => getStatus())
  ipcMain.handle('deepseekCredentials:saveApiKey', (_event, apiKey: string) => {
    // The renderer-declared type is compile-time only; validate the IPC value.
    if (typeof apiKey !== 'string') {
      throw new Error('DeepSeek API key must be a string')
    }
    saveDeepSeekApiKey(apiKey)
    refreshAfterChange(rateLimits, 'save')
    return getStatus()
  })
  ipcMain.handle('deepseekCredentials:clearApiKey', () => {
    clearDeepSeekApiKey()
    refreshAfterChange(rateLimits, 'clear')
    return getStatus()
  })
}
