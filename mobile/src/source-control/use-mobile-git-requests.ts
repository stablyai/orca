import { useCallback, useRef } from 'react'
import type { ConnectionState, RpcSuccess } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import {
  isMobileGitUnavailable,
  type MobileGitStatusResult,
  type MobileGitUpstreamStatus
} from './mobile-git-status'
import type { GitCommitResult, GitRequestError } from './mobile-source-control-screen-state'
import {
  isMobileRemoteGitMethod,
  mobileGitRequestOptions
} from './mobile-git-remote-request-options'
import { GIT_REMOTE_OPERATION_TIMEOUT_MS } from '../../../src/shared/git-remote-operation-timeout'
import { useHostProtocolGates } from '../components/HostProtocolGate'

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
}

// The raw RPC layer for source-control git actions. Pure transport — owns no
// screen state, so it stays out of the giant state hook.
export function useMobileGitRequests({ client, connState, worktreeId }: Params) {
  const { gitRemoteOperationTimeoutMs: remoteOperationTimeoutMs } = useHostProtocolGates()
  const remoteDeadlineRef = useRef<number | null>(null)
  const configuredTimeoutMs =
    typeof remoteOperationTimeoutMs === 'number' &&
    Number.isSafeInteger(remoteOperationTimeoutMs) &&
    remoteOperationTimeoutMs > 0
      ? Math.min(remoteOperationTimeoutMs, GIT_REMOTE_OPERATION_TIMEOUT_MS)
      : GIT_REMOTE_OPERATION_TIMEOUT_MS

  const remoteRemainingMs = useCallback((): number => {
    const deadline = remoteDeadlineRef.current
    if (deadline === null) {
      return configuredTimeoutMs
    }
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) {
      throw new Error('Git remote operation timed out.')
    }
    return remaining
  }, [configuredTimeoutMs])

  const runRemoteGitAction = useCallback(
    async <T>(run: (remainingMs: () => number) => Promise<T>): Promise<T> => {
      if (remoteDeadlineRef.current !== null) {
        return run(remoteRemainingMs)
      }
      const deadline = performance.now() + configuredTimeoutMs
      remoteDeadlineRef.current = deadline
      let timer: ReturnType<typeof setTimeout> | undefined
      const boundary = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Git remote operation timed out.')),
          configuredTimeoutMs
        )
      })
      try {
        return await Promise.race([run(remoteRemainingMs), boundary])
      } finally {
        if (timer) {
          clearTimeout(timer)
        }
        if (remoteDeadlineRef.current === deadline) {
          remoteDeadlineRef.current = null
        }
      }
    },
    [configuredTimeoutMs, remoteRemainingMs]
  )

  const sendGitRequest = useCallback(
    async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      const send = async (): Promise<T> => {
        const timeoutMs = isMobileRemoteGitMethod(method) ? remoteRemainingMs() : undefined
        const response = await client.sendRequest(
          method,
          {
            worktree: `id:${worktreeId}`,
            ...params,
            ...(timeoutMs === undefined ? {} : { operationTimeoutMs: timeoutMs })
          },
          mobileGitRequestOptions(method, timeoutMs)
        )
        if (!response.ok) {
          const error = new Error(
            response.error?.message || 'Source control action failed'
          ) as GitRequestError
          error.code = response.error?.code
          throw error
        }
        return (response as RpcSuccess).result as T
      }
      if (isMobileRemoteGitMethod(method) && remoteDeadlineRef.current === null) {
        return runRemoteGitAction(() => send())
      }
      return send()
    },
    [client, connState, remoteRemainingMs, runRemoteGitAction, worktreeId]
  )

  const sendCommitRequest = useCallback(
    async (message: string): Promise<GitCommitResult> => {
      const result = await sendGitRequest<GitCommitResult>('git.commit', { message })
      if (!result || result.success !== true) {
        throw new Error(result?.error || 'Commit failed')
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
        throw new Error('Branch status unavailable')
      }
      return status.upstreamStatus
    }
  }, [sendGitRequest])

  const runGitSyncSteps = useCallback(
    () =>
      runRemoteGitAction(async () => {
        await sendGitRequest<unknown>('git.fetch')
        await sendGitRequest<unknown>('git.pull')
        const nextUpstream = await readUpstreamStatusForSync()
        if (nextUpstream.ahead > 0) {
          await sendGitRequest<unknown>('git.push')
        }
      }),
    [readUpstreamStatusForSync, runRemoteGitAction, sendGitRequest]
  )

  return { sendGitRequest, sendCommitRequest, runGitSyncSteps, runRemoteGitAction }
}
