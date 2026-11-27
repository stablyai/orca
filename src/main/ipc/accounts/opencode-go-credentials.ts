import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import {
  clearOpenCodeGoApiKey,
  hasOpenCodeGoApiKey,
  saveOpenCodeGoApiKey
} from '../../opencode/accounts/opencode-go-api-key-store'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'
import { refreshAfterCredentialChange } from './credential-change-rate-limit-refresh'

type CredentialRateLimits = Pick<
  RateLimitService,
  'invalidateOpenCodeGoCredentialState' | 'refresh'
>

async function getOpenCodeGoCredentialsStatus(): Promise<{ apiKeyConfigured: boolean }> {
  return { apiKeyConfigured: await hasOpenCodeGoApiKey() }
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
  rateLimits: CredentialRateLimits | null,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('opencodeGoCredentials:getStatus', () => getOpenCodeGoCredentialsStatus())
  ipc.handle('opencodeGoCredentials:saveApiKey', async (_event, key: unknown) => {
    if (typeof key !== 'string') {
      throw new Error('OpenCode Go API key must be a string')
    }
    await saveOpenCodeGoApiKey(key)
    refreshAfterOpenCodeGoCredentialChange(rateLimits, false)
    return getOpenCodeGoCredentialsStatus()
  })
  ipc.handle('opencodeGoCredentials:clearApiKey', async () => {
    await clearOpenCodeGoApiKey()
    refreshAfterOpenCodeGoCredentialChange(rateLimits, true)
    return getOpenCodeGoCredentialsStatus()
  })
}
