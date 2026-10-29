import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { translate } from '../i18n/mobile-i18n'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
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
  workspaceLabel: string | null
  failure: MobileCommitFailureRecovery | null
}

export function useMobileCommitFailureRecovery({
  client,
  connState,
  worktreeId,
  workspaceLabel,
  failure
}: Params) {
  const hostStatus = useHostProtocolGates()
  const { hostCapabilities } = hostStatus
  const [launching, setLaunching] = useState(false)
  // Guard synchronously: launching state commits next render, leaving a gap for duplicate taps.
  const inFlightRef = useRef(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  // Retain prompts for manual paste after launch failure; key by failed commit so a new failure cannot inherit them.
  const [undelivered, setUndelivered] = useState<{
    failure: MobileCommitFailureRecovery
    prompt: string
  } | null>(null)
  const undeliveredPrompt = undelivered?.failure === failure ? undelivered.prompt : null
  const [warning, setWarning] = useState<{
    failure: MobileCommitFailureRecovery
    text: string
  } | null>(null)
  const launchWarning = warning?.failure === failure ? warning.text : null
  const [success, setSuccess] = useState<{
    failure: MobileCommitFailureRecovery
    text: string
  } | null>(null)
  const launchSuccess = success?.failure === failure ? success.text : null
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
    if (inFlightRef.current || launching || !prompt) {
      return false
    }
    if (!client || connState !== 'connected') {
      setLaunchError(
        translate(
          'sourceControl.useMobileCommitFailureRecovery.waitingForDesktop',
          'Waiting for desktop...'
        )
      )
      triggerError()
      return false
    }
    inFlightRef.current = true
    setLaunching(true)
    setLaunchError(null)
    setWarning(null)
    setSuccess(null)
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
      const notice = promptedLaunchNotice(result, workspaceLabel)
      if (notice.succeeded) {
        triggerSuccess()
      } else {
        triggerError()
      }
      setLaunchError(notice.error)
      setWarning(failure && notice.warning ? { failure, text: notice.warning } : null)
      setSuccess(failure && notice.success ? { failure, text: notice.success } : null)
      setUndelivered(
        failure && notice.undeliveredPrompt ? { failure, prompt: notice.undeliveredPrompt } : null
      )
      return notice.succeeded
    } catch (err) {
      triggerError()
      setLaunchError(
        err instanceof Error
          ? err.message
          : translate(
              'sourceControl.useMobileCommitFailureRecovery.launchFailed',
              'Failed to launch agent'
            )
      )
      return false
    } finally {
      inFlightRef.current = false
      setLaunching(false)
    }
  }, [client, connState, failure, hostCapabilities, launching, prompt, workspaceLabel, worktreeId])

  return {
    summary,
    hasDetails,
    launching,
    availability,
    launchError,
    launchWarning,
    launchSuccess,
    undeliveredPrompt,
    launch
  }
}

export type MobileCommitFailureRecoveryAction = ReturnType<typeof useMobileCommitFailureRecovery>
