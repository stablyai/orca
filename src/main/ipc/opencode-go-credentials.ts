import { ipcMain } from 'electron'
import {
  clearOpenCodeGoApiKey,
  hasOpenCodeGoApiKey,
  saveOpenCodeGoApiKey
} from '../opencode/opencode-go-api-key-store'
import type { RateLimitService } from '../rate-limits/service'
import { refreshAfterCredentialChange } from './credential-change-rate-limit-refresh'

type CredentialRateLimits = Pick<
  RateLimitService,
  'invalidateOpenCodeGoCredentialState' | 'refresh'
>

function getOpenCodeGoCredentialsStatus(): { apiKeyConfigured: boolean } {
  return { apiKeyConfigured: hasOpenCodeGoApiKey() }
}

function refreshAfterOpenCodeGoCredentialChange(
  rateLimits: CredentialRateLimits | null,
  apiKeyCleared: boolean
): void {
  refreshAfterCredentialChange(
    rateLimits,
    (service) => service.invalidateOpenCodeGoCredentialState({ apiKeyCleared }),
    '[opencode-go] failed to refresh usage after a credential change:'
  )
}

export function registerOpenCodeGoCredentialsHandlers(
  rateLimits: CredentialRateLimits | null
): void {
  ipcMain.handle('opencodeGoCredentials:getStatus', () => getOpenCodeGoCredentialsStatus())
  ipcMain.handle('opencodeGoCredentials:saveApiKey', (_event, key: unknown) => {
    if (typeof key !== 'string') {
      throw new Error('OpenCode Go API key must be a string')
    }
    saveOpenCodeGoApiKey(key)
    refreshAfterOpenCodeGoCredentialChange(rateLimits, false)
    return getOpenCodeGoCredentialsStatus()
  })
  ipcMain.handle('opencodeGoCredentials:clearApiKey', () => {
    clearOpenCodeGoApiKey()
    refreshAfterOpenCodeGoCredentialChange(rateLimits, true)
    return getOpenCodeGoCredentialsStatus()
  })
}
