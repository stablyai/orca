import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import {
  connectBitbucket,
  disconnectBitbucket,
  getBitbucketConnectionStatus
} from '../../bitbucket/credential-connection'

import { _resetPreflightCache } from '../../preflight/agent-detection'
import {
  type BitbucketConnectArgs,
  type BitbucketConnectResult,
  type BitbucketConnectionStatus,
  bitbucketConnectFailure
} from '../../../shared/bitbucket/bitbucket-credentials'

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

export function registerBitbucketHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  ipc.handle(
    'bitbucket:connect',
    async (_event, args: unknown): Promise<BitbucketConnectResult> => {
      const input = normalizeConnectInput(args)
      if (!input) {
        return bitbucketConnectFailure('invalidInput')
      }
      const result = await connectBitbucket(input)
      if (result.ok) {
        // Refresh cached source-control preflight so reconnection needs no relaunch.
        _resetPreflightCache()
      }
      return result
    }
  )

  ipc.handle('bitbucket:disconnect', async (): Promise<void> => {
    await disconnectBitbucket()
    _resetPreflightCache()
  })

  ipc.handle('bitbucket:status', async (): Promise<BitbucketConnectionStatus> => {
    return getBitbucketConnectionStatus()
  })
}
