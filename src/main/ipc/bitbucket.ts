import { ipcMain } from 'electron'
import {
  connectBitbucket,
  disconnectBitbucket,
  getBitbucketConnectionStatus,
  type BitbucketConnectArgs,
  type BitbucketConnectResult,
  type BitbucketConnectionStatus
} from '../bitbucket/credential-connection'
import { _resetPreflightCache } from './preflight'

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeConnectInput(value: unknown): BitbucketConnectArgs | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  if (raw.authMode !== 'token' && raw.authMode !== 'basic') {
    return null
  }
  return {
    authMode: raw.authMode,
    accessToken: optionalString(raw.accessToken),
    email: optionalString(raw.email),
    apiToken: optionalString(raw.apiToken),
    baseUrl: optionalString(raw.baseUrl)
  }
}

export function registerBitbucketHandlers(): void {
  ipcMain.handle(
    'bitbucket:connect',
    async (_event, args: unknown): Promise<BitbucketConnectResult> => {
      const input = normalizeConnectInput(args)
      if (!input) {
        return { ok: false, error: 'Invalid Bitbucket credentials' }
      }
      const result = await connectBitbucket(input)
      if (result.ok) {
        // Preflight caches source-control status per session; reset so the card
        // reflects the new connection without a relaunch.
        _resetPreflightCache()
      }
      return result
    }
  )

  ipcMain.handle('bitbucket:disconnect', async (): Promise<void> => {
    disconnectBitbucket()
    _resetPreflightCache()
  })

  ipcMain.handle('bitbucket:status', async (): Promise<BitbucketConnectionStatus> => {
    return getBitbucketConnectionStatus()
  })
}
