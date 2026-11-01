import { useCallback, useMemo, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { GitHubPrRepoSlug } from './github-pr-rpc'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import {
  fetchUpdatePRBody,
  fetchUpdatePRTitle,
  type GitHubPrMutationOutcome
} from './github-pr-mutations'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { buildUpdatePRBodyParams, buildUpdatePRTitleParams } from './pr-title-edit'

export type PrTextField = 'title' | 'body'

export type PrTextMutations = {
  updateTitle: (args: {
    prNumber: number
    title: string
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  updateBody: (args: {
    prNumber: number
    body: string
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
}

export type PrTextActionInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  prNumber: number
  prRepo?: GitHubPrRepoSlug | null
  refetch: () => void | Promise<void>
  mutations?: PrTextMutations
}

function realMutations(client: RpcOperationSender, worktreeId: string): PrTextMutations {
  return {
    updateTitle: (args) => fetchUpdatePRTitle(client, worktreeId, args),
    updateBody: (args) => fetchUpdatePRBody(client, worktreeId, args)
  }
}

// Title and description edits share one in-flight lock: both rewrite the same PR.
export function useMobilePrTextAction(input: PrTextActionInput) {
  const t = useMobileTranslation()
  const { client, connState, worktreeId, prNumber, prRepo, refetch } = input
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | { kind: 'disconnected' | 'updateFailed' } | null>(
    null
  )
  const inFlightRef = useRef(false)

  const mutations = useMemo(
    () => input.mutations ?? (client ? realMutations(client, worktreeId) : null),
    [input.mutations, client, worktreeId]
  )
  const ready = mutations !== null && (input.mutations !== undefined || connState === 'connected')

  const save = useCallback(
    async (field: PrTextField, draft: string, current: string): Promise<boolean> => {
      const params =
        field === 'title'
          ? buildUpdatePRTitleParams(prNumber, draft, current)
          : buildUpdatePRBodyParams(prNumber, draft, current)
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
      try {
        const outcome =
          'title' in params
            ? await mutations.updateTitle({ ...params, prRepo })
            : await mutations.updateBody({ ...params, prRepo })
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
        setError(err instanceof Error ? err.message : { kind: 'updateFailed' })
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
    error:
      typeof error === 'string' || error === null
        ? error
        : error.kind === 'disconnected'
          ? t('session.usePrTitleAction.disconnected', 'Not connected to desktop.')
          : t('session.usePrTextAction.updateFailed', 'Failed to update pull request.'),
    clearError: useCallback(() => setError(null), []),
    save
  }
}

export type MobilePrTextAction = ReturnType<typeof useMobilePrTextAction>
