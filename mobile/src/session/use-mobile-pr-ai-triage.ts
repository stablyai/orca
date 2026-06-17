import { useCallback, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import {
  readMobileReviewCreatedTerminal,
  readMobileReviewTerminalSendAccepted
} from './mobile-diff-review-rpc'

// Launches an agent for the PR triage actions ("Fix checks with AI" / "Resolve
// conflicts with AI"). Reuses the same two RPCs the diff-review send flow uses —
// session.tabs.createTerminal then terminal.send — so the prompt is dropped into a
// fresh agent terminal in the worktree. There is no higher-level agent-composer RPC
// on mobile, so this createTerminal+send pair is the launch mechanism.

export type PrAiTriageKey = 'fix-checks' | 'resolve-conflicts'

type Input = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
}

async function createTerminalAndSendPrompt(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  prompt: string
): Promise<void> {
  const created = await client.sendRequest('session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`
  })
  if (!created.ok) {
    throw new Error(created.error?.message || 'Failed to create terminal')
  }
  const terminalTab = readMobileReviewCreatedTerminal(created.result)
  if (!terminalTab) {
    throw new Error('Created terminal response was invalid')
  }
  const sent = await client.sendRequest('terminal.send', {
    terminal: terminalTab.terminal,
    text: prompt,
    enter: true
  })
  if (!sent.ok) {
    throw new Error(sent.error?.message || 'Failed to send prompt')
  }
  if (!readMobileReviewTerminalSendAccepted(sent.result)) {
    throw new Error('Terminal input is locked')
  }
}

export function useMobilePrAiTriage(input: Input) {
  const { client, connState, worktreeId } = input
  const [busyKey, setBusyKey] = useState<PrAiTriageKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  const launch = useCallback(
    async (key: PrAiTriageKey, buildPrompt: () => string): Promise<boolean> => {
      // Guard re-entry: one triage launch at a time keeps us from opening a pile
      // of terminals on a fast double-tap.
      if (busyKey !== null) {
        return false
      }
      if (!client || connState !== 'connected') {
        setError('Waiting for desktop…')
        triggerError()
        return false
      }
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
