import { ipcMain } from 'electron'
import {
  clearCommandCodeSessionCookie,
  hasCommandCodeSessionCookie,
  saveCommandCodeSessionCookie
} from '../command-code/command-code-cookie-store'
import type { RateLimitService } from '../rate-limits/service'

export type CommandCodeCredentialsStatus = {
  configured: boolean
}

function getCommandCodeCredentialsStatus(): CommandCodeCredentialsStatus {
  return { configured: hasCommandCodeSessionCookie() }
}

function refreshAfterCommandCodeCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  rateLimits?.invalidateCommandCodeCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[command-code] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerCommandCodeCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('commandCodeCredentials:getStatus', () => getCommandCodeCredentialsStatus())
  ipcMain.handle('commandCodeCredentials:saveCookie', (_event, cookie: string) => {
    if (typeof cookie !== 'string') {
      throw new Error('Command Code session cookie must be a string')
    }
    saveCommandCodeSessionCookie(cookie)
    refreshAfterCommandCodeCredentialChange(rateLimits, 'save')
    return getCommandCodeCredentialsStatus()
  })
  ipcMain.handle('commandCodeCredentials:clearCookie', async () => {
    clearCommandCodeSessionCookie()
    refreshAfterCommandCodeCredentialChange(rateLimits, 'clear')
    return getCommandCodeCredentialsStatus()
  })
}
