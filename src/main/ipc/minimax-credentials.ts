import { ipcMain } from 'electron'
import {
  clearMiniMaxSessionCookie,
  hasMiniMaxSessionCookie,
  saveMiniMaxSessionCookie
} from '../minimax/minimax-cookie-store'
import type { RateLimitService } from '../rate-limits/service'

export type MiniMaxCredentialsStatus = {
  configured: boolean
}

function getMiniMaxCredentialsStatus(): MiniMaxCredentialsStatus {
  return { configured: hasMiniMaxSessionCookie() }
}

export function registerMiniMaxCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('minimaxCredentials:getStatus', () => getMiniMaxCredentialsStatus())
  ipcMain.handle('minimaxCredentials:saveCookie', (_event, cookie: string) => {
    saveMiniMaxSessionCookie(cookie)
    void rateLimits?.refresh().catch((error: unknown) => {
      console.error('[minimax] failed to trigger rate-limit refresh after save:', error)
    })
    return getMiniMaxCredentialsStatus()
  })
  ipcMain.handle('minimaxCredentials:clearCookie', () => {
    clearMiniMaxSessionCookie()
    void rateLimits?.refresh().catch((error: unknown) => {
      console.error('[minimax] failed to trigger rate-limit refresh after clear:', error)
    })
    return getMiniMaxCredentialsStatus()
  })
}
