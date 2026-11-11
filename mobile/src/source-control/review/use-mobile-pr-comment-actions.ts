import { useCallback, useMemo, useRef, useState } from 'react'
import type { PRComment } from '../../../../src/shared/github/comment-types'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { GitHubPrRepoSlug } from './github-pr-repo-slug'
import { useHostMutation } from '../../query/host-mutation'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import {
  buildAddRootCommentParams,
  buildDeleteCommentParams,
  buildEditCommentParams,
  buildReplyParams,
  buildResolveParams
} from './pr-comment-actions'
import { prCommentTarget, prCommentWrite, type PrCommentWrite } from './pr-comment-writes'
import type { PrQueryScope } from './mobile-pr-queries'
import { workspaceDraftRowKey } from '../../drafts/durable-draft-rows'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'

export type PrCommentActionsInput = {
  hostId: string
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  prNumber: number
  prRepo?: GitHubPrRepoSlug | null
  /** The shown PR's reads; a write patches its cached comments and re-reads only them. */
  queries: PrQueryScope | null
}

// Track busy state per comment so one write cannot disable unrelated reply/resolve controls.
function replyKey(commentId: number): string {
  return `reply:${commentId}`
}
function resolveKey(threadId: string): string {
  return `resolve:${threadId}`
}
function editKey(commentId: number): string {
  return `edit:${commentId}`
}
function deleteKey(commentId: number): string {
  return `delete:${commentId}`
}
const ROOT_KEY = 'root'

export function useMobilePrCommentActions(input: PrCommentActionsInput) {
  const t = useMobileTranslation()
  const { hostId, client, connState, worktreeId, prNumber, prRepo, queries } = input
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | { kind: 'actionFailed' } | null>(null)
  // Guard against overlapping fires of the same key (double-tap before the write settles).
  const inFlightRef = useRef<Set<string>>(new Set())
  const { mutate, blockedOffline } = useHostMutation(prCommentWrite, { hostId, client })
  const ready = client !== null && connState === 'connected' && !blockedOffline
  const target = useMemo(() => prCommentTarget(queries), [queries])
  const executionHost = useWorkspaceExecutionHost()
  // A fork's #N and upstream #N keep separate drafts; null is a new root comment.
  const draftKey = useCallback(
    (replyTo: number | null): string | null => {
      if (prNumber <= 0) {
        return null
      }
      const repo = prRepo ? `${prRepo.host ?? ''}/${prRepo.owner}/${prRepo.repo}` : ''
      return workspaceDraftRowKey(
        'prComment',
        { hostId, executionHost, worktreeId },
        `${repo}#${prNumber}#${replyTo ?? 'new'}`
      )
    },
    [executionHost, hostId, prNumber, prRepo, worktreeId]
  )

  const setBusy = useCallback((key: string, busy: boolean) => {
    setBusyKeys((prev) => {
      const next = new Set(prev)
      if (busy) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
  }, [])

  const run = useCallback(
    async (key: string, change: PrCommentWrite): Promise<boolean> => {
      if (!ready || inFlightRef.current.has(key)) {
        return false
      }
      inFlightRef.current.add(key)
      setBusy(key, true)
      setError(null)
      try {
        await mutate({ worktreeId, prRepo: prRepo ?? null, target, write: change })
        triggerSuccess()
        return true
      } catch (err) {
        // Contain refusals as false with feedback; callers rely on the boolean contract.
        triggerError()
        setError(err instanceof Error ? err.message : { kind: 'actionFailed' })
        return false
      } finally {
        inFlightRef.current.delete(key)
        setBusy(key, false)
      }
    },
    [mutate, prRepo, ready, setBusy, target, worktreeId]
  )

  const reply = useCallback(
    (comment: PRComment, body: string) =>
      run(replyKey(comment.id), {
        kind: 'reply',
        params: buildReplyParams(prNumber, comment, body)
      }),
    [prNumber, run]
  )

  const toggleResolve = useCallback(
    (comment: PRComment) => {
      const params = buildResolveParams(comment)
      if (!params) {
        return Promise.resolve(false)
      }
      return run(resolveKey(params.threadId), { kind: 'resolve', params })
    },
    [run]
  )

  const addRootComment = useCallback(
    (body: string) =>
      run(ROOT_KEY, { kind: 'root', params: buildAddRootCommentParams(prNumber, body) }),
    [prNumber, run]
  )

  const editComment = useCallback(
    (commentId: number, body: string) => {
      if (!prRepo) {
        return Promise.resolve(false)
      }
      return run(editKey(commentId), {
        kind: 'edit',
        params: buildEditCommentParams(prRepo, commentId, body)
      })
    },
    [prRepo, run]
  )

  const deleteComment = useCallback(
    (commentId: number) => {
      if (!prRepo) {
        return Promise.resolve(false)
      }
      return run(deleteKey(commentId), {
        kind: 'delete',
        params: buildDeleteCommentParams(prRepo, commentId)
      })
    },
    [prRepo, run]
  )

  return {
    ready,
    error:
      typeof error === 'string' || error === null
        ? error
        : t('session.usePrCommentActions.actionFailed', 'Comment action failed'),
    clearError: useCallback(() => setError(null), []),
    isReplyBusy: useCallback((commentId: number) => busyKeys.has(replyKey(commentId)), [busyKeys]),
    isResolveBusy: useCallback(
      (threadId: string) => busyKeys.has(resolveKey(threadId)),
      [busyKeys]
    ),
    isEditBusy: useCallback((commentId: number) => busyKeys.has(editKey(commentId)), [busyKeys]),
    isDeleteBusy: useCallback(
      (commentId: number) => busyKeys.has(deleteKey(commentId)),
      [busyKeys]
    ),
    isRootBusy: busyKeys.has(ROOT_KEY),
    draftKey,
    reply,
    toggleResolve,
    addRootComment,
    editComment,
    deleteComment
  }
}

export type MobilePrCommentActions = ReturnType<typeof useMobilePrCommentActions>
