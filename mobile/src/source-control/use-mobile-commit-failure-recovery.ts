import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { createTerminalAndSendPrompt } from '../session/pr-ai-triage-launch'
import {
  buildFixCommitFailurePrompt,
  type MobileCommitFailureRecovery,
  hasExpandedCommitFailureDetails,
  summarizeCommitFailure
} from './mobile-commit-failure-recovery'

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  failure: MobileCommitFailureRecovery | null
}

export function useMobileCommitFailureRecovery({ client, connState, worktreeId, failure }: Params) {
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const summary = useMemo(() => (failure ? summarizeCommitFailure(failure.error) : null), [failure])

  useEffect(() => {
    setLaunchError(null)
  }, [failure])

  const hasDetails = useMemo(
    () => (failure && summary ? hasExpandedCommitFailureDetails(failure.error, summary) : false),
    [failure, summary]
  )
  const prompt = useMemo(
    () =>
      failure && summary
        ? buildFixCommitFailurePrompt({
            summary,
            error: failure.error,
            entries: failure.stagedEntries,
            worktreePath: null,
            commitMessage: failure.commitMessage
          })
        : null,
    [failure, summary]
  )

  const launch = useCallback(async (): Promise<boolean> => {
    if (launching || !prompt) {
      return false
    }
    if (!client || connState !== 'connected') {
      setLaunchError('Waiting for desktop...')
      triggerError()
      return false
    }
    setLaunching(true)
    setLaunchError(null)
    try {
      await createTerminalAndSendPrompt(client, worktreeId, prompt)
      triggerSuccess()
      return true
    } catch (err) {
      triggerError()
      setLaunchError(err instanceof Error ? err.message : 'Failed to launch agent')
      return false
    } finally {
      setLaunching(false)
    }
  }, [client, connState, launching, prompt, worktreeId])

  return {
    summary,
    hasDetails,
    launching,
    launchError,
    launch
  }
}

export type MobileCommitFailureRecoveryAction = ReturnType<typeof useMobileCommitFailureRecovery>
