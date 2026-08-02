import { useCallback, useMemo, useRef, useState } from 'react'
import type { PRComment } from '../../../src/shared/types'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { GitHubPrRepoSlug } from './github-pr-rpc'
import {
  fetchAddIssueComment,
  fetchAddPRReviewCommentReply,
  fetchDeleteIssueComment,
  fetchResolveReviewThread,
  fetchUpdateIssueComment,
  type GitHubPrMutationOutcome
} from './github-pr-mutations'
import { triggerError, triggerSuccess } from '../platform/haptics'
import {
  buildAddRootCommentParams,
  buildDeleteCommentParams,
  buildEditCommentParams,
  buildReplyParams,
  buildResolveParams
} from './pr-comment-actions'

export type PrCommentMutations = {
  reply: (args: {
    prNumber: number
    commentId: number
    body: string
    threadId?: string
    path?: string
    line?: number
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  resolveThread: (args: {
    threadId: string
    resolve: boolean
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  addRootComment: (args: {
    prNumber: number
    body: string
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  editComment: (args: {
    owner: string
    repo: string
    host?: string
    commentId: number
    body: string
  }) => Promise<GitHubPrMutationOutcome>
  deleteComment: (args: {
    owner: string
    repo: string
    host?: string
    commentId: number
  }) => Promise<GitHubPrMutationOutcome>
}

export type PrCommentActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  prNumber: number
  prRepo?: GitHubPrRepoSlug | null
  // Re-fetches the authoritative comment timeline after a successful mutation so
  // the new reply/comment and toggled resolve state appear (desktop merges the
  // returned comment; mobile keeps it simple with a full refetch).
  refetch: () => void | Promise<void>
  // Test seam: inject fake mutations; defaults to the real github.* wrappers.
  mutations?: PrCommentMutations
}

function realMutations(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): PrCommentMutations {
  return {
    reply: (args) => fetchAddPRReviewCommentReply(client, worktreeId, args),
    resolveThread: (args) => fetchResolveReviewThread(client, worktreeId, args),
    addRootComment: (args) => fetchAddIssueComment(client, worktreeId, args),
    // Edit/delete are slug-addressed (owner/repo/commentId), so they take no worktreeId.
    editComment: (args) => fetchUpdateIssueComment(client, args),
    deleteComment: (args) => fetchDeleteIssueComment(client, args)
  }
}

// Stable busy keys: 'root' for the root composer; otherwise per-comment so one
// reply/resolve in flight doesn't disable every other card.
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

// React adapter for the three interactive comment actions. Tracks per-action
// in-flight keys + a single error message, fires haptics, and refetches on success.
export function useMobilePrCommentActions(input: PrCommentActionsInput) {
  const { client, connState, worktreeId, prNumber, prRepo, refetch } = input
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  // Guard against overlapping fires of the same key (double-tap before refetch).
  const inFlightRef = useRef<Set<string>>(new Set())

  const mutations = useMemo(
    () => input.mutations ?? (client ? realMutations(client, worktreeId) : null),
    [input.mutations, client, worktreeId]
  )
  const ready = mutations !== null && (input.mutations !== undefined || connState === 'connected')

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
    async (key: string, mutate: () => Promise<GitHubPrMutationOutcome>): Promise<boolean> => {
      if (!ready || inFlightRef.current.has(key)) {
        return false
      }
      inFlightRef.current.add(key)
      setBusy(key, true)
      setError(null)
      try {
        const outcome = await mutate()
        if (outcome.ok) {
          triggerSuccess()
          await refetch()
          return true
        }
        triggerError()
        setError(outcome.error)
        return false
      } catch (err) {
        // Why: if a mutation (or the refetch) throws, still honor the boolean
        // contract — error haptic + message, return false — rather than rejecting.
        triggerError()
        setError(err instanceof Error ? err.message : 'Comment action failed')
        return false
      } finally {
        inFlightRef.current.delete(key)
        setBusy(key, false)
      }
    },
    [ready, refetch, setBusy]
  )

  const reply = useCallback(
    (comment: PRComment, body: string) => {
      if (!mutations) {
        return Promise.resolve(false)
      }
      const params = buildReplyParams(prNumber, comment, body)
      return run(replyKey(comment.id), () => mutations.reply({ ...params, prRepo }))
    },
    [mutations, prNumber, prRepo, run]
  )

  const toggleResolve = useCallback(
    (comment: PRComment) => {
      const params = buildResolveParams(comment)
      if (!mutations || !params) {
        return Promise.resolve(false)
      }
      return run(resolveKey(params.threadId), () => mutations.resolveThread({ ...params, prRepo }))
    },
    [mutations, prRepo, run]
  )

  const addRootComment = useCallback(
    (body: string) => {
      if (!mutations) {
        return Promise.resolve(false)
      }
      const params = buildAddRootCommentParams(prNumber, body)
      return run(ROOT_KEY, () => mutations.addRootComment({ ...params, prRepo }))
    },
    [mutations, prNumber, prRepo, run]
  )

  const editComment = useCallback(
    (commentId: number, body: string) => {
      // Edit is slug-addressed, so a missing prRepo means we cannot target the comment.
      if (!mutations || !prRepo) {
        return Promise.resolve(false)
      }
      const params = buildEditCommentParams(prRepo, commentId, body)
      return run(editKey(commentId), () => mutations.editComment(params))
    },
    [mutations, prRepo, run]
  )

  const deleteComment = useCallback(
    (commentId: number) => {
      if (!mutations || !prRepo) {
        return Promise.resolve(false)
      }
      const params = buildDeleteCommentParams(prRepo, commentId)
      return run(deleteKey(commentId), () => mutations.deleteComment(params))
    },
    [mutations, prRepo, run]
  )

  return {
    ready,
    error,
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
    reply,
    toggleResolve,
    addRootComment,
    editComment,
    deleteComment
  }
}

export type MobilePrCommentActions = ReturnType<typeof useMobilePrCommentActions>
