import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ClinePassCredentialsStatus } from '../../shared/clinepass-credentials'
import {
  clearClinePassApiKey,
  getClinePassCredentialsStatus,
  saveClinePassApiKey
} from '../clinepass/clinepass-api-key-store'
import type { RateLimitService } from '../rate-limits/service'
import { isTrustedUIRenderer } from './ui'

function assertTrustedClinePassCredentialsSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedUIRenderer(event.sender)) {
    throw new Error('Unauthorized ClinePass credentials sender')
  }
}

// Why: fire-and-forget — callers get the persisted credential status immediately;
// the rate-limit refresh runs in the background and only logs on failure.
function refreshAfterClinePassCredentialChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  rateLimits?.invalidateClinePassCredentialState()
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[clinepass] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

export function registerClinePassCredentialsHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('clinePassCredentials:getStatus', (event): ClinePassCredentialsStatus => {
    assertTrustedClinePassCredentialsSender(event)
    return getClinePassCredentialsStatus()
  })
  ipcMain.handle(
    'clinePassCredentials:saveApiKey',
    (event, apiKey: unknown): ClinePassCredentialsStatus => {
      assertTrustedClinePassCredentialsSender(event)
      // Validate the IPC argument in the main process; the renderer-declared type
      // is compile-time only and the value arrives as unknown over IPC.
      if (typeof apiKey !== 'string') {
        throw new Error('ClinePass API key must be a string')
      }
      saveClinePassApiKey(apiKey)
      refreshAfterClinePassCredentialChange(rateLimits, 'save')
      return getClinePassCredentialsStatus()
    }
  )
  ipcMain.handle('clinePassCredentials:clearApiKey', (event): ClinePassCredentialsStatus => {
    assertTrustedClinePassCredentialsSender(event)
    clearClinePassApiKey()
    refreshAfterClinePassCredentialChange(rateLimits, 'clear')
    return getClinePassCredentialsStatus()
  })
}
