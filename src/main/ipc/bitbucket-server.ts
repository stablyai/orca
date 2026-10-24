import { ipcMain } from 'electron'
import {
  connectBitbucketServer,
  disconnectBitbucketServer,
  getBitbucketServerConnectionStatus
} from '../bitbucket/server-credential-connection'
import { _resetBitbucketServerRepoRefCache } from '../bitbucket/server-repository-ref'
import { _resetPreflightCache } from '../preflight/agent-detection'
import { invalidateAllHostedReviewBranchCaches } from '../source-control/hosted-review-branch-cache'
import type {
  BitbucketServerConnectArgs,
  BitbucketServerConnectionStatus,
  BitbucketServerConnectResult
} from '../../shared/bitbucket-server-credentials'

function normalizeConnectInput(value: unknown): BitbucketServerConnectArgs | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const baseUrl = 'baseUrl' in value ? value.baseUrl : null
  const accessToken = 'accessToken' in value ? value.accessToken : null
  return typeof baseUrl === 'string' && typeof accessToken === 'string'
    ? { baseUrl, accessToken }
    : null
}

// Why: repo detection caches "not a server repo" for minutes, and the review cache
// serves its last answer when a lookup fails — both must follow the credential at once.
function resetDetectionCaches(): void {
  _resetBitbucketServerRepoRefCache()
  invalidateAllHostedReviewBranchCaches()
  _resetPreflightCache()
}

export function registerBitbucketServerHandlers(): void {
  ipcMain.handle(
    'bitbucketServer:connect',
    async (_event, args: unknown): Promise<BitbucketServerConnectResult> => {
      const input = normalizeConnectInput(args)
      if (!input) {
        return { ok: false, error: 'Invalid Bitbucket Server credentials' }
      }
      const result = await connectBitbucketServer(input)
      if (result.ok) {
        resetDetectionCaches()
      }
      return result
    }
  )

  ipcMain.handle('bitbucketServer:disconnect', async (): Promise<void> => {
    try {
      disconnectBitbucketServer()
    } finally {
      resetDetectionCaches()
    }
  })

  ipcMain.handle('bitbucketServer:status', async (): Promise<BitbucketServerConnectionStatus> =>
    getBitbucketServerConnectionStatus()
  )
}
