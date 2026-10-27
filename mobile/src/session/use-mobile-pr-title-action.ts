import { useCallback, useMemo, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { GitHubPrRepoSlug } from './github-pr-rpc'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { fetchUpdatePRTitle, type GitHubPrMutationOutcome } from './github-pr-mutations'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { buildUpdatePRTitleParams } from './pr-title-edit'

export type PrTitleMutations = {
  updateTitle: (args: {
    prNumber: number
    title: string
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
}

export type PrTitleActionInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  prNumber: number
  prRepo?: GitHubPrRepoSlug | null
  refetch: () => void | Promise<void>
  mutations?: PrTitleMutations
}

function realMutations(client: RpcOperationSender, worktreeId: string): PrTitleMutations {
  return {
    updateTitle: (args) => fetchUpdatePRTitle(client, worktreeId, args)
  }
}

export function useMobilePrTitleAction(input: PrTitleActionInput) {
  const { client, connState, worktreeId, prNumber, prRepo, refetch } = input
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlightRef = useRef(false)

  const mutations = useMemo(
    () => input.mutations ?? (client ? realMutations(client, worktreeId) : null),
    [input.mutations, client, worktreeId]
  )
  const ready = mutations !== null && (input.mutations !== undefined || connState === 'connected')

  const setTitle = useCallback(
    async (draft: string, current: string): Promise<boolean> => {
      const params = buildUpdatePRTitleParams(prNumber, draft, current)
      if (!params) {
        return true
      }
      if (inFlightRef.current) {
        return false
      }
      // Offline Save must explain failure and leave the editor open rather than silently do nothing.
      if (!ready || !mutations) {
        setError('Not connected to desktop.')
        return false
      }
      inFlightRef.current = true
      setSaving(true)
      setError(null)
      try {
        const outcome = await mutations.updateTitle({ ...params, prRepo })
        if (outcome.ok) {
          triggerSuccess()
          await refetch()
          return true
        }
        triggerError()
        setError(outcome.error)
        return false
      } catch (err) {
        // Contain fire-and-forget save/refetch rejection and return false with feedback.
        triggerError()
        setError(err instanceof Error ? err.message : 'Failed to update title.')
        return false
      } finally {
        inFlightRef.current = false
        setSaving(false)
      }
    },
    [ready, mutations, prNumber, prRepo, refetch]
  )

  return {
    ready,
    saving,
    error,
    clearError: useCallback(() => setError(null), []),
    setTitle
  }
}

export type MobilePrTitleAction = ReturnType<typeof useMobilePrTitleAction>
