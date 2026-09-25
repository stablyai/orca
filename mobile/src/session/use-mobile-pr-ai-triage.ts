import { useCallback, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { launchAgentWithPrompt, promptedLaunchNotice } from './pr-ai-triage-launch'
import {
  resolveMobileAgentLaunchAvailability,
  type MobileAgentLaunchAvailability
} from './mobile-agent-launch-availability'

// Launches an agent for the PR triage actions ("Fix checks with AI" / "Resolve
// conflicts with AI") via launchAgentWithPrompt; see pr-ai-triage-launch.ts.

export type PrAiTriageKey = 'fix-checks' | 'resolve-conflicts'

// The desktop's saved-recipe ids and telemetry sources for the same two buttons.
const TRIAGE_LAUNCH = {
  'fix-checks': { actionId: 'fixChecks', launchSource: 'task_page' },
  'resolve-conflicts': { actionId: 'resolveConflicts', launchSource: 'conflict_resolution' }
} as const

type Input = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  hostCapabilities: readonly string[]
  hostStatusPending: boolean
  hostStatusReadable: boolean
}

export function useMobilePrAiTriage(input: Input) {
  const { client, connState, worktreeId, hostCapabilities, hostStatusPending, hostStatusReadable } =
    input
  const [busyKey, setBusyKey] = useState<PrAiTriageKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The agent started without its prompt; kept so the user can paste it in themselves.
  const [undeliveredPrompt, setUndeliveredPrompt] = useState<string | null>(null)
  // Synchronous lock: setBusyKey commits async, so a fast double-tap could pass the
  // busyKey check twice before either render. The ref flips immediately and dedupes.
  const inFlightRef = useRef(false)
  const availability: MobileAgentLaunchAvailability = resolveMobileAgentLaunchAvailability({
    hostCapabilities,
    statusPending: hostStatusPending,
    statusReadable: hostStatusReadable
  })

  const launch = useCallback(
    async (key: PrAiTriageKey, buildPrompt: () => string): Promise<boolean> => {
      // Guard re-entry: one triage launch at a time keeps us from opening a pile
      // of agents on a fast double-tap.
      if (inFlightRef.current || busyKey !== null) {
        return false
      }
      if (!client || connState !== 'connected') {
        setError('Waiting for desktop…')
        triggerError()
        return false
      }
      inFlightRef.current = true
      setBusyKey(key)
      setError(null)
      setUndeliveredPrompt(null)
      try {
        const prompt = buildPrompt()
        const result = await launchAgentWithPrompt({
          client,
          hostCapabilities,
          worktreeId,
          prompt,
          ...TRIAGE_LAUNCH[key]
        })
        const notice = promptedLaunchNotice(result)
        if (notice.succeeded) {
          triggerSuccess()
        } else {
          triggerError()
        }
        setError(notice.error)
        setUndeliveredPrompt(notice.undeliveredPrompt)
        return notice.succeeded
      } catch (err) {
        triggerError()
        setError(err instanceof Error ? err.message : 'Failed to launch agent')
        return false
      } finally {
        inFlightRef.current = false
        setBusyKey(null)
      }
    },
    [busyKey, client, connState, hostCapabilities, worktreeId]
  )

  return {
    availability,
    error,
    undeliveredPrompt,
    clearError: useCallback(() => {
      setError(null)
      setUndeliveredPrompt(null)
    }, []),
    isBusy: useCallback((key: PrAiTriageKey) => busyKey === key, [busyKey]),
    launch
  }
}

export type MobilePrAiTriage = ReturnType<typeof useMobilePrAiTriage>
