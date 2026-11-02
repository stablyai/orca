import { ipcMain } from 'electron'
import {
  clearMiniMaxApiKeyCredential,
  clearMiniMaxSessionCookieCredential,
  getMiniMaxCredentialsStatus,
  saveMiniMaxApiKeyCredential,
  saveMiniMaxSessionCookieCredential
} from '../minimax/minimax-credential-commands'
import type { RateLimitService } from '../rate-limits/service'

export function registerMiniMaxCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('minimaxCredentials:getStatus', () => getMiniMaxCredentialsStatus())
  ipcMain.handle('minimaxCredentials:saveCookie', (_event, cookie: unknown) =>
    saveMiniMaxSessionCookieCredential(rateLimits, cookie)
  )
  ipcMain.handle('minimaxCredentials:clearCookie', () =>
    clearMiniMaxSessionCookieCredential(rateLimits)
  )
  ipcMain.handle('minimaxCredentials:saveApiKey', (_event, key: unknown) =>
    saveMiniMaxApiKeyCredential(rateLimits, key)
  )
  ipcMain.handle('minimaxCredentials:clearApiKey', () => clearMiniMaxApiKeyCredential(rateLimits))
}
