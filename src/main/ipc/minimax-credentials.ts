import { ipcMain } from 'electron'
import {
  clearMiniMaxSessionCookie,
  hasMiniMaxSessionCookie,
  saveMiniMaxSessionCookie
} from '../minimax/minimax-cookie-store'
import { clearMiniMaxSessionCookieJar } from '../rate-limits/minimax-request-context'
import type { RateLimitService } from '../rate-limits/service'

export type MiniMaxCredentialsStatus = {
  configured: boolean
}

function getMiniMaxCredentialsStatus(): MiniMaxCredentialsStatus {
  return { configured: hasMiniMaxSessionCookie() }
}

// Why: fire-and-forget — callers get the persisted cookie status immediately;
// the rate-limit refresh runs in the background and only logs on failure.
function refreshAfterMiniMaxCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  rateLimits?.invalidateMiniMaxCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[minimax] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerMiniMaxCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('minimaxCredentials:getStatus', () => getMiniMaxCredentialsStatus())
  ipcMain.handle('minimaxCredentials:saveCookie', (_event, cookie: string) => {
    // Validate the IPC argument in the main process; the renderer-declared type
    // is compile-time only and the value arrives as unknown over IPC.
    if (typeof cookie !== 'string') {
      throw new Error('MiniMax session cookie must be a string')
    }
    saveMiniMaxSessionCookie(cookie)
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
}
