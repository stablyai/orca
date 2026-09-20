import { ipcMain } from 'electron'
import {
  clearOpenRouterApiKey,
  hasOpenRouterApiKey,
  saveOpenRouterApiKey
} from '../openrouter/openrouter-api-key-store'
import type { RateLimitService } from '../rate-limits/service'

export type OpenRouterCredentialsStatus = {
  configured: boolean
  apiKeyConfigured: boolean
}

function getOpenRouterCredentialsStatus(): OpenRouterCredentialsStatus {
  const apiKeyConfigured = hasOpenRouterApiKey()
  return { configured: apiKeyConfigured, apiKeyConfigured }
}

// Why: fire-and-forget — the caller gets the persisted status immediately; the
// rate-limit refresh runs in the background and only logs on failure. Mirrors
// refreshAfterMiniMaxCredentialChange.
function refreshAfterOpenRouterCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[openrouter] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerOpenRouterCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('openrouterCredentials:getStatus', () => getOpenRouterCredentialsStatus())
  ipcMain.handle('openrouterCredentials:saveApiKey', (_event, key: string) => {
    // Validate the IPC argument in the main process; the renderer-declared type
    // is compile-time only and the value arrives as unknown over IPC.
    if (typeof key !== 'string') {
      throw new Error('OpenRouter API key must be a string')
    }
    saveOpenRouterApiKey(key)
    refreshAfterOpenRouterCredentialChange(rateLimits, 'save')
    return getOpenRouterCredentialsStatus()
  })
  ipcMain.handle('openrouterCredentials:clearApiKey', () => {
    clearOpenRouterApiKey()
    refreshAfterOpenRouterCredentialChange(rateLimits, 'clear')
    return getOpenRouterCredentialsStatus()
  })
}
