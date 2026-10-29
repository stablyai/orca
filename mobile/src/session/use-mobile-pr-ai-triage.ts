import { useCallback, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import {
  launchAgentWithPrompt,
  promptedLaunchNotice,
  type MobilePromptedAgentLaunch,
  type PromptedLaunchNotice
} from './pr-ai-triage-launch'
import {
  resolveMobileAgentLaunchAvailability,
  type MobileAgentLaunchAvailability
} from './mobile-agent-launch-availability'

export type PrAiTriageKey = 'fix-checks' | 'resolve-conflicts'

const TRIAGE_LAUNCH = {
  'fix-checks': { actionId: 'fixChecks', launchSource: 'task_page' },
  'resolve-conflicts': { actionId: 'resolveConflicts', launchSource: 'conflict_resolution' }
} as const

const NO_LAUNCH_NOTICE: PromptedLaunchNotice = {
  launch: null,
  error: null,
  undeliveredPrompt: null
}

type TriageLaunchResult = {
  client: RpcClient | null
  worktreeId: string
  result: MobilePromptedAgentLaunch
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
  const [results, setResults] = useState<Partial<Record<PrAiTriageKey, TriageLaunchResult>>>({})
  // Lock synchronously because async busy state cannot stop same-frame double-tap launches.
  const inFlightRef = useRef(false)
  const availability: MobileAgentLaunchAvailability = resolveMobileAgentLaunchAvailability({
    hostCapabilities,
    statusPending: hostStatusPending,
    statusReadable: hostStatusReadable
  })

  const setResult = useCallback(
    (key: PrAiTriageKey, result: MobilePromptedAgentLaunch | null) => {
      setResults((current) => ({
        ...current,
        [key]: result ? { client, worktreeId, result } : undefined
      }))
    },
    [client, worktreeId]
  )

  const launch = useCallback(
    async (key: PrAiTriageKey, buildPrompt: () => string | Promise<string>): Promise<boolean> => {
      if (inFlightRef.current) {
        return false
      }
      if (!client || connState !== 'connected') {
        setResult(key, { kind: 'not-started', message: 'Waiting for desktop…' })
        triggerError()
        return false
      }
      inFlightRef.current = true
      setBusyKey(key)
      setResult(key, null)
      try {
        const prompt = await buildPrompt()
        const result = await launchAgentWithPrompt({
          client,
          hostCapabilities,
          worktreeId,
          prompt,
          ...TRIAGE_LAUNCH[key]
        })
        const succeeded = result.kind === 'sent'
        if (succeeded) {
          triggerSuccess()
        } else {
          triggerError()
        }
        setResult(key, result)
        return succeeded
      } catch (err) {
        triggerError()
        setResult(key, {
          kind: 'not-started',
          message: err instanceof Error ? err.message : 'Failed to launch agent'
        })
        return false
      } finally {
        inFlightRef.current = false
        setBusyKey(null)
      }
    },
    [client, connState, hostCapabilities, setResult, worktreeId]
  )

  return {
    availability,
    noticeFor: (key: PrAiTriageKey): PromptedLaunchNotice => {
      const stored = results[key]
      return stored?.client === client && stored.worktreeId === worktreeId
        ? promptedLaunchNotice(stored.result)
        : NO_LAUNCH_NOTICE
    },
    isBusy: useCallback((key: PrAiTriageKey) => busyKey === key, [busyKey]),
    launch
  }
}

export type MobilePrAiTriage = ReturnType<typeof useMobilePrAiTriage>
