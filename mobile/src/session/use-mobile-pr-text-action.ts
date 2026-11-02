import { useCallback, useMemo, useRef, useState } from 'react'
import { githubRepoIdentityKey } from '../../../src/shared/github/repository-identity-key'
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
import {
  buildUpdatePRBodyParams,
  buildUpdatePRTitleParams,
  createPrTextEditOwnership
} from './pr-title-edit'

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
  const [ownership] = useState(createPrTextEditOwnership)
  // A write that settles after the view moved to another PR must not show its error there or reread for it.
  const identity = `${prNumber}:${prRepo ? githubRepoIdentityKey(prRepo) : ''}`
  const identityRef = useRef(identity)
  identityRef.current = identity

  const mutations = useMemo(
    () => input.mutations ?? (client ? realMutations(client, worktreeId) : null),
    [input.mutations, client, worktreeId]
  )
  const ready = mutations !== null && (input.mutations !== undefined || connState === 'connected')

  const write = useCallback(
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
      const isCurrent = (): boolean => identityRef.current === identity
      try {
        const outcome =
          'title' in params
            ? await mutations.updateTitle({ ...params, prRepo })
            : await mutations.updateBody({ ...params, prRepo })
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
        // A failed response doesn't prove the host kept the old text, so every attempted write rereads.
        // The write decides Save's result; a failed reread is contained and keeps the shown PR.
        if (isCurrent()) {
          try {
            await refetch()
          } catch {
            // Keep the write's outcome.
          }
        }
      }
    },
    [ready, mutations, prNumber, prRepo, refetch, identity]
  )
  const save = useCallback(
    (field: PrTextField, draft: string, current: string): Promise<boolean> =>
      ownership.save(() => write(field, draft, current)),
    [ownership, write]
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
    // Opening or cancelling an editor starts a new edit, so an older Save cannot close it.
    clearError: useCallback(() => {
      ownership.touch()
      setError(null)
    }, [ownership]),
    touch: ownership.touch,
    save
  }
}

export type MobilePrTextAction = ReturnType<typeof useMobilePrTextAction>
