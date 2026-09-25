import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { useHostProtocolGates } from '../components/HostProtocolGate'
import { launchAgentWithPrompt, promptedLaunchNotice } from '../session/pr-ai-triage-launch'
import { resolveMobileAgentLaunchAvailability } from '../session/mobile-agent-launch-availability'
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
  const hostStatus = useHostProtocolGates()
  const { hostCapabilities } = hostStatus
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  // The agent started without its prompt; kept so the user can paste it in themselves. Keyed by the
  // failure it was built for, so a new failure never shows the previous one's prompt.
  const [undelivered, setUndelivered] = useState<{
    failure: MobileCommitFailureRecovery
    prompt: string
  } | null>(null)
  const undeliveredPrompt = undelivered?.failure === failure ? undelivered.prompt : null
  const summary = useMemo(() => (failure ? summarizeCommitFailure(failure.error) : null), [failure])
  const availability = resolveMobileAgentLaunchAvailability(hostStatus)

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
    setUndelivered(null)
    try {
      const result = await launchAgentWithPrompt({
        client,
        hostCapabilities,
        worktreeId,
        prompt,
        actionId: 'fixCommitFailure',
        launchSource: 'source_control_recovery'
      })
      const notice = promptedLaunchNotice(result)
      if (notice.succeeded) {
        triggerSuccess()
      } else {
        triggerError()
      }
      setLaunchError(notice.error)
      setUndelivered(
        failure && notice.undeliveredPrompt ? { failure, prompt: notice.undeliveredPrompt } : null
      )
      return notice.succeeded
    } catch (err) {
      triggerError()
      setLaunchError(err instanceof Error ? err.message : 'Failed to launch agent')
      return false
    } finally {
      setLaunching(false)
    }
  }, [client, connState, failure, hostCapabilities, launching, prompt, worktreeId])

  return {
    summary,
    hasDetails,
    launching,
    availability,
    launchError,
    undeliveredPrompt,
    launch
  }
}

export type MobileCommitFailureRecoveryAction = ReturnType<typeof useMobileCommitFailureRecovery>
