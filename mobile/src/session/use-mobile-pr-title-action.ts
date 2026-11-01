import { useCallback, useMemo, useRef, useState } from 'react'
import { githubRepoIdentityKey } from '../../../src/shared/github/repository-identity-key'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { GitHubPrRepoSlug } from './github-pr-rpc'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { fetchUpdatePRTitle, type GitHubPrMutationOutcome } from './github-pr-mutations'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
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
  refetch: (options?: { reconcile?: boolean }) => void | Promise<void>
  mutations?: PrTitleMutations
}

function realMutations(client: RpcOperationSender, worktreeId: string): PrTitleMutations {
  return {
    updateTitle: (args) => fetchUpdatePRTitle(client, worktreeId, args)
  }
}

export function useMobilePrTitleAction(input: PrTitleActionInput) {
  const t = useMobileTranslation()
  const { client, connState, worktreeId, prNumber, prRepo, refetch } = input
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | { kind: 'disconnected' | 'updateFailed' } | null>(
    null
  )
  const inFlightRef = useRef(false)
  // Why: a write that settles after the view moved to another PR must not show its error there or reread for it.
  const identity = `${prNumber}:${prRepo ? githubRepoIdentityKey(prRepo) : ''}`
  const identityRef = useRef(identity)
  identityRef.current = identity

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
        setError({ kind: 'disconnected' })
        return false
      }
      inFlightRef.current = true
      setSaving(true)
      setError(null)
      const isCurrent = (): boolean => identityRef.current === identity
      try {
        const outcome = await mutations.updateTitle({ ...params, prRepo })
        if (outcome.ok) {
          triggerSuccess()
          return true
        }
        triggerError()
        if (isCurrent()) {
          setError(outcome.error)
        }
        return false
      } catch (err) {
        // Contain fire-and-forget save rejection and return false with feedback.
        triggerError()
        if (isCurrent()) {
          setError(err instanceof Error ? err.message : { kind: 'updateFailed' })
        }
        return false
      } finally {
        inFlightRef.current = false
        setSaving(false)
        // Why: a failed response doesn't prove the host kept the old title, so every attempted write rereads.
        // The write decides Save's result; a failed reread is contained and keeps the shown PR.
        if (isCurrent()) {
          try {
            await refetch({ reconcile: true })
          } catch {
            // Keep the write's outcome.
          }
        }
      }
    },
    [ready, mutations, prNumber, prRepo, refetch, identity]
  )

  return {
    ready,
    saving,
    error:
      typeof error === 'string' || error === null
        ? error
        : error.kind === 'disconnected'
          ? t('session.usePrTitleAction.disconnected', 'Not connected to desktop.')
          : t('session.usePrTitleAction.updateFailed', 'Failed to update title.'),
    clearError: useCallback(() => setError(null), []),
    setTitle
  }
}

export type MobilePrTitleAction = ReturnType<typeof useMobilePrTitleAction>
