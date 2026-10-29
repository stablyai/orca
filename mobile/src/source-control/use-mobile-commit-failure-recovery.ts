import { useCallback, useMemo, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import {
  launchAgentWithPrompt,
  promptedLaunchNotice,
  type MobilePromptedAgentLaunch
} from '../session/pr-ai-triage-launch'
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
  // Guard synchronously: launching state commits next render, leaving a gap for duplicate taps.
  const inFlightRef = useRef(false)
  const [launchResult, setLaunchResult] = useState<{
    client: RpcClient | null
    worktreeId: string
    failure: MobileCommitFailureRecovery
    result: MobilePromptedAgentLaunch
  } | null>(null)
  const notice =
    launchResult?.client === client &&
    launchResult.worktreeId === worktreeId &&
    launchResult.failure === failure
      ? promptedLaunchNotice(launchResult.result)
      : null
  const summary = useMemo(() => (failure ? summarizeCommitFailure(failure.error) : null), [failure])
  const availability = resolveMobileAgentLaunchAvailability(hostStatus)

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
    if (inFlightRef.current || !failure || !prompt) {
      return false
    }
    if (!client || connState !== 'connected') {
      setLaunchResult({
        client,
        worktreeId,
        failure,
        result: { kind: 'not-started', message: 'Waiting for desktop...' }
      })
      triggerError()
      return false
    }
    inFlightRef.current = true
    setLaunching(true)
    setLaunchResult(null)
    try {
      const result = await launchAgentWithPrompt({
        client,
        hostCapabilities,
        worktreeId,
        prompt,
        actionId: 'fixCommitFailure',
        launchSource: 'source_control_recovery'
      })
      const succeeded = result.kind === 'sent'
      if (succeeded) {
        triggerSuccess()
      } else {
        triggerError()
      }
      setLaunchResult({ client, worktreeId, failure, result })
      return succeeded
    } catch (err) {
      triggerError()
      setLaunchResult({
        client,
        worktreeId,
        failure,
        result: {
          kind: 'not-started',
          message: err instanceof Error ? err.message : 'Failed to launch agent'
        }
      })
      return false
    } finally {
      inFlightRef.current = false
      setLaunching(false)
    }
  }, [client, connState, failure, hostCapabilities, prompt, worktreeId])

  return {
    summary,
    hasDetails,
    launching,
    availability,
    launchError: notice?.error ?? null,
    launchedAgent: notice?.launch ?? null,
    undeliveredPrompt: notice?.undeliveredPrompt ?? null,
    launch
  }
}

export type MobileCommitFailureRecoveryAction = ReturnType<typeof useMobileCommitFailureRecovery>
