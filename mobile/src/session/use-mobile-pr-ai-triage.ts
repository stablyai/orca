import { useCallback, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { createTerminalAndSendPrompt } from './pr-ai-triage-launch'

// Launches an agent for the PR triage actions ("Fix checks with AI" / "Resolve
// conflicts with AI") via createTerminalAndSendPrompt; see pr-ai-triage-launch.ts.

export type PrAiTriageKey = 'fix-checks' | 'resolve-conflicts'

type Input = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
}

export function useMobilePrAiTriage(input: Input) {
  const { client, connState, worktreeId } = input
  const [busyKey, setBusyKey] = useState<PrAiTriageKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Synchronous lock: setBusyKey commits async, so a fast double-tap could pass the
  // busyKey check twice before either render. The ref flips immediately and dedupes.
  const inFlightRef = useRef(false)

  const launch = useCallback(
    async (key: PrAiTriageKey, buildPrompt: () => string): Promise<boolean> => {
      // Guard re-entry: one triage launch at a time keeps us from opening a pile
      // of terminals on a fast double-tap.
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
      try {
        await createTerminalAndSendPrompt(client, worktreeId, buildPrompt())
        triggerSuccess()
        return true
      } catch (err) {
        triggerError()
        setError(err instanceof Error ? err.message : 'Failed to launch agent')
        return false
      } finally {
        inFlightRef.current = false
        setBusyKey(null)
      }
    },
    [busyKey, client, connState, worktreeId]
  )

  return {
    error,
    clearError: useCallback(() => setError(null), []),
    isBusy: useCallback((key: PrAiTriageKey) => busyKey === key, [busyKey]),
    launch
  }
}

export type MobilePrAiTriage = ReturnType<typeof useMobilePrAiTriage>
