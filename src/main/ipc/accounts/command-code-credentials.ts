import { ipcMain } from 'electron'
import {
  clearCommandCodeApiKeyCredential,
  getCommandCodeCredentialsStatus,
  saveCommandCodeApiKeyCredential
} from '../../command-code/command-code-credential-commands'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'

export function registerCommandCodeCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('commandCodeCredentials:getStatus', () => getCommandCodeCredentialsStatus())
  ipcMain.handle('commandCodeCredentials:saveApiKey', (_event, key: unknown) =>
    saveCommandCodeApiKeyCredential(rateLimits, key)
  )
  ipcMain.handle('commandCodeCredentials:clearApiKey', () =>
    clearCommandCodeApiKeyCredential(rateLimits)
  )
}
