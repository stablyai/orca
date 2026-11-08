import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { QueryKey } from '@tanstack/react-query'
import { githubRepoIdentityKey } from '../../../src/shared/github/repository-identity-key'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { GitHubPrRepoSlug } from './github-pr-rpc'
import { defineHostMutation, useHostMutation } from '../query/host-mutation'
import { hostQueryKey } from '../query/host-query-key'
import { fetchUpdatePRBody, fetchUpdatePRTitle } from './github-pr-mutations'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  buildUpdatePRBodyParams,
  buildUpdatePRTitleParams,
  createPrTextEditOwnership
} from './pr-title-edit'
import {
  patchPrDetails,
  patchPrSummary,
  prBranchReviewQuery,
  prDetailsQuery,
  type PrQueryScope
} from './mobile-pr-queries'

export type PrTextField = 'title' | 'body'

export type PrTextActionInput = {
  hostId: string
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  prNumber: number
  prRepo?: GitHubPrRepoSlug | null
  /** The shown PR's reads, which the saved text is written into. */
  queries: PrQueryScope | null
}

type PrTextWriteVars = {
  worktreeId: string
  prNumber: number
  prRepo: GitHubPrRepoSlug | null
  field: PrTextField
  text: string
  summaryKey: QueryKey | null
  detailsKey: QueryKey | null
}

async function sendTextWrite(client: RpcClient, vars: PrTextWriteVars): Promise<void> {
  const { worktreeId, prNumber, prRepo, text } = vars
  const outcome =
    vars.field === 'title'
      ? await fetchUpdatePRTitle(client, worktreeId, { prNumber, title: text, prRepo })
      : await fetchUpdatePRBody(client, worktreeId, { prNumber, body: text, prRepo })
  if (!outcome.ok) {
    throw new Error(outcome.error)
  }
}

// The saved text is the whole change, so a confirmed write needs no re-read; a refusal puts the old text back.
const prTextWrite = defineHostMutation({
  offline: 'draft',
  send: sendTextWrite,
  // Setting the same text again is harmless, so a lost reply is settled by sending it again.
  confirm: sendTextWrite,
  optimistic: {
    keys: (_hostId, vars: PrTextWriteVars) =>
      [vars.summaryKey, vars.detailsKey].filter((key): key is QueryKey => key !== null),
    apply: (queryClient, _hostId, vars) => {
      const { text } = vars
      if (vars.field === 'title') {
        if (vars.summaryKey) {
          patchPrSummary(queryClient, vars.summaryKey, (pr) => ({ ...pr, title: text }))
        }
        if (vars.detailsKey) {
          patchPrDetails(queryClient, vars.detailsKey, (details) => ({
            ...details,
            item: { ...details.item, title: text }
          }))
        }
      } else if (vars.detailsKey) {
        patchPrDetails(queryClient, vars.detailsKey, (details) => ({ ...details, body: text }))
      }
    }
  }
})

// Title and description edits share one in-flight lock: both rewrite the same PR.
export function useMobilePrTextAction(input: PrTextActionInput) {
  const t = useMobileTranslation()
  const { hostId, client, connState, worktreeId, prNumber, prRepo, queries } = input
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | { kind: 'disconnected' | 'updateFailed' } | null>(
    null
  )
  const inFlightRef = useRef(false)
  const [ownership] = useState(createPrTextEditOwnership)
  // A write that settles after the view moved to another PR must not show its error there.
  const identity = `${prNumber}:${prRepo ? githubRepoIdentityKey(prRepo) : ''}`
  const identityRef = useRef(identity)
  useLayoutEffect(() => {
    identityRef.current = identity
  })
  const { mutate, blockedOffline } = useHostMutation(prTextWrite, { hostId, client })
  const ready = client !== null && connState === 'connected' && !blockedOffline
  const keys = useMemo(
    () => ({
      summaryKey:
        queries?.branchInput != null
          ? hostQueryKey(hostId, prBranchReviewQuery.family, queries.target, queries.branchInput)
          : null,
      detailsKey:
        queries?.detailsInput != null
          ? hostQueryKey(hostId, prDetailsQuery.family, queries.target, queries.detailsInput)
          : null
    }),
    [hostId, queries]
  )

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
      if (!ready) {
        setError({ kind: 'disconnected' })
        return false
      }
      inFlightRef.current = true
      setSaving(true)
      setError(null)
      const isCurrent = (): boolean => identityRef.current === identity
      try {
        await mutate({
          worktreeId,
          prNumber,
          prRepo: prRepo ?? null,
          field,
          text: 'title' in params ? params.title : params.body,
          ...keys
        })
        triggerSuccess()
        return true
      } catch (err) {
        triggerError()
        if (isCurrent()) {
          setError(err instanceof Error ? err.message : { kind: 'updateFailed' })
        }
        return false
      } finally {
        inFlightRef.current = false
        setSaving(false)
      }
    },
    [identity, keys, mutate, prNumber, prRepo, ready, worktreeId]
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
