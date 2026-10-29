import { useCallback } from 'react'
import type { ConnectionState, RpcSuccess } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { translate } from '../i18n/mobile-i18n'
import {
  isMobileGitUnavailable,
  type MobileGitStatusResult,
  type MobileGitUpstreamStatus
} from './mobile-git-status'
import type { GitCommitResult, GitRequestError } from './mobile-source-control-screen-state'

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

  const readUpstreamStatusForSync = useCallback(async (): Promise<MobileGitUpstreamStatus> => {
    try {
      return await sendGitRequest<MobileGitUpstreamStatus>('git.upstreamStatus')
    } catch (err) {
      const code = err instanceof Error ? (err as GitRequestError).code : undefined
      const message = err instanceof Error ? err.message : String(err)
      if (!isMobileGitUnavailable(code, message)) {
        throw err
      }
      const status = await sendGitRequest<MobileGitStatusResult>('git.status')
      if (!status.upstreamStatus) {
        throw new Error(
          translate(
            'sourceControl.useMobileGitRequests.branchUnavailable',
            'Branch status unavailable'
          )
        )
      }
      return status.upstreamStatus
    }
  }, [sendGitRequest])

  const runGitSyncSteps = useCallback(async () => {
    await sendGitRequest<unknown>('git.fetch')
    await sendGitRequest<unknown>('git.pull')
    const nextUpstream = await readUpstreamStatusForSync()
    if (nextUpstream.ahead > 0) {
      await sendGitRequest<unknown>('git.push')
    }
  }, [readUpstreamStatusForSync, sendGitRequest])

  return { sendGitRequest, sendCommitRequest, runGitSyncSteps }
}
