import { useCallback, useMemo, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { GitHubPrRepoSlug } from './github-pr-rpc'
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
  // Re-fetches authoritative PR data after a successful title edit so the new
  // title appears (mobile keeps it simple with a full refetch, like the other actions).
  refetch: () => void | Promise<void>
  // Test seam: inject fake mutations; defaults to the real github.* wrapper.
  mutations?: PrTitleMutations
}

function realMutations(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): PrTitleMutations {
  return {
    updateTitle: (args) => fetchUpdatePRTitle(client, worktreeId, args)
  }
}

// React adapter for the inline title edit. Tracks a single in-flight + error state,
// fires haptics, and refetches on success. Empty/unchanged drafts short-circuit to a
// successful no-op (the caller closes the editor) without a host round-trip.
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
      // No-op when empty/unchanged: report success so the editor closes silently.
      if (!params) {
        return true
      }
      if (inFlightRef.current) {
        return false
      }
      // Why: surface an explicit error when offline/not-ready so Save doesn't
      // silently no-op (the editor stays open with a reason instead of nothing).
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
        // Why: updateTitle/refetch can throw; without this the `void save()`
        // rejection is unhandled — set the error + error haptic and return false.
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
