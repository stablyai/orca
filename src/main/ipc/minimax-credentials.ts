import { ipcMain } from 'electron'
import {
  clearMiniMaxSessionCookie,
  getMiniMaxSessionCookieProtection,
  hasMiniMaxSessionCookie,
  saveMiniMaxSessionCookie
} from '../minimax/minimax-cookie-store'
import {
  clearMiniMaxApiKey,
  getMiniMaxApiKeyProtection,
  hasMiniMaxApiKey,
  saveMiniMaxApiKey
} from '../minimax/minimax-api-key-store'
import { clearMiniMaxSessionCookieJar } from '../rate-limits/minimax/minimax-request-context'
import { refreshAfterCredentialChange } from './credential-change-rate-limit-refresh'
import type { RateLimitService } from '../rate-limits/service'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'

export type MiniMaxCredentialsStatus = {
  configured: boolean
  cookieConfigured: boolean
  apiKeyConfigured: boolean
  /** How each stored credential sits on disk, so Settings can warn when it is unsealed. */
  cookieProtection: SecretAtRestProtection | null
  apiKeyProtection: SecretAtRestProtection | null
}

function getMiniMaxCredentialsStatus(): MiniMaxCredentialsStatus {
  const cookieConfigured = hasMiniMaxSessionCookie()
  const apiKeyConfigured = hasMiniMaxApiKey()
  return {
    configured: cookieConfigured || apiKeyConfigured,
    cookieConfigured,
    apiKeyConfigured,
    cookieProtection: cookieConfigured ? getMiniMaxSessionCookieProtection() : null,
    apiKeyProtection: apiKeyConfigured ? getMiniMaxApiKeyProtection() : null
  }
}

function refreshAfterMiniMaxCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  refreshAfterCredentialChange(
    rateLimits,
    (service) => service.invalidateMiniMaxCredentialState(),
    `[minimax] failed to trigger rate-limit refresh after ${action}:`
  )
}

export function registerMiniMaxCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('minimaxCredentials:getStatus', () => getMiniMaxCredentialsStatus())
  ipcMain.handle('minimaxCredentials:saveCookie', async (_event, cookie: string) => {
    // Validate the IPC argument in the main process; the renderer-declared type
    // is compile-time only and the value arrives as unknown over IPC.
    if (typeof cookie !== 'string') {
      throw new Error('MiniMax session cookie must be a string')
    }
    await saveMiniMaxSessionCookie(cookie)
    refreshAfterMiniMaxCredentialChange(rateLimits, 'save')
    return getMiniMaxCredentialsStatus()
  })
  ipcMain.handle('minimaxCredentials:clearCookie', async () => {
    clearMiniMaxSessionCookie()
    try {
      await clearMiniMaxSessionCookieJar()
    } catch (error) {
      console.error('[minimax] failed to clear session cookie jar after credential clear:', error)
    }
    refreshAfterMiniMaxCredentialChange(rateLimits, 'clear')
    return getMiniMaxCredentialsStatus()
  })
  ipcMain.handle('minimaxCredentials:saveApiKey', async (_event, key: string) => {
    if (typeof key !== 'string') {
      throw new Error('MiniMax API key must be a string')
    }
    await saveMiniMaxApiKey(key)
    refreshAfterMiniMaxCredentialChange(rateLimits, 'save')
    return getMiniMaxCredentialsStatus()
  })
  ipcMain.handle('minimaxCredentials:clearApiKey', () => {
    clearMiniMaxApiKey()
    refreshAfterMiniMaxCredentialChange(rateLimits, 'clear')
    return getMiniMaxCredentialsStatus()
  })
}
