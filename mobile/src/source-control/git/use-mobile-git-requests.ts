import { useCallback } from 'react'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcSuccess } from '../../transport/rpc/rpc-wire-types'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { translate } from '../../i18n/mobile-i18n'
import { gitStatusHostPayloadSchema, gitUpstreamStatusSchema } from './git-status-reply-schema'
import { isMobileGitUnavailable } from '../changes/mobile-git-status'
import type { MobileGitUpstreamStatus } from './git-status-reply-schema'
import type {
  GitCommitResult,
  GitRequestError
} from '../changes/mobile-source-control-screen-state'

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
}

export function useMobileGitRequests({ client, connState, worktreeId }: Params) {
  const sendGitRequest = useCallback(
    async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (!client || connState !== 'connected') {
        throw new Error(
          translate(
            'sourceControl.useMobileGitRequests.waitingForDesktop',
            'Waiting for desktop...'
          )
        )
      }
      const response = await client.sendRequest(method, {
        worktree: `id:${worktreeId}`,
        ...params
      })
      if (!response.ok) {
        const error: GitRequestError = new Error(
          response.error?.message ||
            translate(
              'sourceControl.useMobileGitRequests.actionFailed',
              'Source control action failed'
            )
        )
        error.code = response.error?.code
        throw error
      }
      return (response as RpcSuccess).result as T
    },
    [client, connState, worktreeId]
  )

  const sendCommitRequest = useCallback(
    async (message: string): Promise<GitCommitResult> => {
      const result = await sendGitRequest<GitCommitResult>('git.commit', { message })
      if (!result || result.success !== true) {
        throw new Error(
          result?.error ||
            translate('sourceControl.useMobileGitRequests.commitFailed', 'Commit failed')
        )
      }
      return result
    },
    [sendGitRequest]
  )

  const runGitSyncSteps = useCallback(
    async () => await runMobileGitSyncSteps(sendGitRequest),
    [sendGitRequest]
  )

  return { sendGitRequest, sendCommitRequest, runGitSyncSteps }
}

type SendGitRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>

function branchStatusUnavailable(): Error {
  return new Error(
    translate('sourceControl.useMobileGitRequests.branchUnavailable', 'Branch status unavailable')
  )
}

// Checked, not cast: an unreadable `ahead` would otherwise skip the push without a word.
async function readUpstreamStatusForSync(
  sendGitRequest: SendGitRequest
): Promise<MobileGitUpstreamStatus> {
  let reply: unknown
  try {
    reply = await sendGitRequest('git.upstreamStatus')
  } catch (err) {
    const code = err instanceof Error ? (err as GitRequestError).code : undefined
    const message = err instanceof Error ? err.message : String(err)
    if (!isMobileGitUnavailable(code, message)) {
      throw err
    }
    const status = gitStatusHostPayloadSchema.safeParse(await sendGitRequest('git.status'))
    if (!status.success || !status.data.upstreamStatus) {
      throw branchStatusUnavailable()
    }
    return status.data.upstreamStatus
  }
  const upstream = gitUpstreamStatusSchema.safeParse(reply)
  if (!upstream.success) {
    throw branchStatusUnavailable()
  }
  return upstream.data
}

export async function runMobileGitSyncSteps(sendGitRequest: SendGitRequest): Promise<void> {
  await sendGitRequest('git.fetch')
  await sendGitRequest('git.pull')
  const nextUpstream = await readUpstreamStatusForSync(sendGitRequest)
  if (nextUpstream.ahead > 0) {
    await sendGitRequest('git.push')
  }
}
