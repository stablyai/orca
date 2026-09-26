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

/** What the last launch from one button left to show under that button. */
export type PrAiTriageLaunchNotice = {
  error: string | null
  warning: string | null
  /** The agent started without its prompt; kept so the user can paste it in themselves. */
  undeliveredPrompt: string | null
}

const NO_LAUNCH_NOTICE: PrAiTriageLaunchNotice = {
  error: null,
  warning: null,
  undeliveredPrompt: null
}

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
  // Keyed by button, so one button's launch never shows (or offers to copy) under the other.
  const [notices, setNotices] = useState<Partial<Record<PrAiTriageKey, PrAiTriageLaunchNotice>>>({})
  // Synchronous lock: setBusyKey commits async, so a fast double-tap could pass the
  // busyKey check twice before either render. The ref flips immediately and dedupes.
  const inFlightRef = useRef(false)
  const availability: MobileAgentLaunchAvailability = resolveMobileAgentLaunchAvailability({
    hostCapabilities,
    statusPending: hostStatusPending,
    statusReadable: hostStatusReadable
  })

  const setNotice = useCallback((key: PrAiTriageKey, notice: PrAiTriageLaunchNotice) => {
    setNotices((current) => ({ ...current, [key]: notice }))
  }, [])

  const launch = useCallback(
    async (key: PrAiTriageKey, buildPrompt: () => string): Promise<boolean> => {
      // Guard re-entry: one triage launch at a time keeps us from opening a pile
      // of agents on a fast double-tap.
      if (inFlightRef.current || busyKey !== null) {
        return false
      }
      if (!client || connState !== 'connected') {
        setNotice(key, { ...NO_LAUNCH_NOTICE, error: 'Waiting for desktop…' })
        triggerError()
        return false
      }
      inFlightRef.current = true
      setBusyKey(key)
      setNotice(key, NO_LAUNCH_NOTICE)
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
        setNotice(key, {
          error: notice.error,
          warning: notice.warning,
          undeliveredPrompt: notice.undeliveredPrompt
        })
        return notice.succeeded
      } catch (err) {
        triggerError()
        setNotice(key, {
          ...NO_LAUNCH_NOTICE,
          error: err instanceof Error ? err.message : 'Failed to launch agent'
        })
        return false
      } finally {
        inFlightRef.current = false
        setBusyKey(null)
      }
    },
    [busyKey, client, connState, hostCapabilities, setNotice, worktreeId]
  )

  return {
    availability,
    noticeFor: (key: PrAiTriageKey): PrAiTriageLaunchNotice => notices[key] ?? NO_LAUNCH_NOTICE,
    isBusy: useCallback((key: PrAiTriageKey) => busyKey === key, [busyKey]),
    launch
  }
}

export type MobilePrAiTriage = ReturnType<typeof useMobilePrAiTriage>
