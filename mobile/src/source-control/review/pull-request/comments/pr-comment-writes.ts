import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { PRComment } from '../../../../../../src/shared/github/comments/comment-types'
import type { GitHubWorkItemDetails } from '../../../../../../src/shared/github/work-items/work-item-types'
import { defineHostMutation } from '../../../../query/host-mutation'
import { translate } from '../../../../i18n/mobile-i18n'
import { isLogicalClientCutoverError } from '../../../../transport/connection/logical-client-cutover-error'
import {
  isRpcDeliveryUnknown,
  markRpcDeliveryUnknown
} from '../../../../transport/rpc/rpc-delivery-ambiguity'
import type { UnvalidatedRpcRequestPort } from '../../../../transport/rpc/unvalidated-rpc-request-port'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import {
  fetchAddIssueComment,
  fetchAddPRReviewCommentReply,
  fetchDeleteIssueComment,
  fetchResolveReviewThread,
  fetchUpdateIssueComment
} from '../../github-operations/github-pr-mutations'
import '../../github-operations/github-pr-mutation-outcome'
import type { GitHubPrMutationOutcome } from '../../github-operations/github-pr-mutation-outcome'
import { fetchAddPRReviewComment } from '../../github-operations/github-pr-review-line-mutations'
import type { GitHubPrRepoSlug } from '../../github-operations/github-pr-repo-slug'
import {
  acceptPrComments,
  patchPrDetails,
  prQueryKeys,
  readPrComments,
  type PrDetailsInput,
  type PrQueryScope
} from '../mobile-pr-queries'
import type {
  AddRootCommentParams,
  DeleteCommentParams,
  EditCommentParams,
  ReplyParams,
  ResolveParams
} from './pr-comment-actions'

export type PrCommentWrite =
  | { kind: 'reply'; params: ReplyParams }
  | { kind: 'resolve'; params: ResolveParams }
  | { kind: 'root'; params: AddRootCommentParams }
  | { kind: 'edit'; params: EditCommentParams }
  | { kind: 'delete'; params: DeleteCommentParams }
  | {
      kind: 'line'
      params: {
        prNumber: number
        commitId: string
        path: string
        line: number
        startLine?: number
        body: string
      }
    }

/** The cached details a comment write lands in, or null when none are loaded for this PR. */
export type PrCommentTarget = { key: QueryKey; input: PrDetailsInput } | null

export type PrCommentWriteVars = {
  worktreeId: string
  prRepo: GitHubPrRepoSlug | null
  target: PrCommentTarget
  write: PrCommentWrite
}

export function prCommentTarget(queries: PrQueryScope | null): PrCommentTarget {
  const { detailsKey } = prQueryKeys(queries)
  return detailsKey && queries?.detailsInput
    ? { key: detailsKey, input: queries.detailsInput }
    : null
}

function sendWrite(
  client: UnvalidatedRpcRequestPort,
  vars: PrCommentWriteVars
): Promise<GitHubPrMutationOutcome> {
  const { worktreeId, prRepo, write } = vars
  switch (write.kind) {
    case 'reply':
      return fetchAddPRReviewCommentReply(client, worktreeId, { ...write.params, prRepo })
    case 'resolve':
      return fetchResolveReviewThread(client, worktreeId, { ...write.params, prRepo })
    case 'root':
      return fetchAddIssueComment(client, worktreeId, { ...write.params, prRepo })
    case 'edit':
      return fetchUpdateIssueComment(client, write.params)
    case 'delete':
      return fetchDeleteIssueComment(client, write.params)
    case 'line':
      return fetchAddPRReviewComment(client, worktreeId, { ...write.params, prRepo })
  }
}

function mapComments(
  details: GitHubWorkItemDetails,
  change: (comment: PRComment) => PRComment | null
): GitHubWorkItemDetails {
  return { ...details, comments: details.comments.flatMap((comment) => change(comment) ?? []) }
}

// What the write does to the shown comments before the host answers; new comments wait for the re-read.
function applyWrite(details: GitHubWorkItemDetails, write: PrCommentWrite): GitHubWorkItemDetails {
  switch (write.kind) {
    case 'resolve':
      return mapComments(details, (comment) =>
        comment.threadId === write.params.threadId
          ? { ...comment, isResolved: write.params.resolve }
          : comment
      )
    case 'edit':
      return mapComments(details, (comment) =>
        comment.id === write.params.commentId ? { ...comment, body: write.params.body } : comment
      )
    case 'delete':
      return mapComments(details, (comment) =>
        comment.id === write.params.commentId ? null : comment
      )
    case 'reply':
    case 'root':
    case 'line':
      return details
  }
}

// Puts back only what this write changed, so another write that settled meanwhile keeps its result.
function revertWrite(
  current: GitHubWorkItemDetails,
  before: GitHubWorkItemDetails,
  write: PrCommentWrite
): GitHubWorkItemDetails {
  const was = new Map(before.comments.map((comment) => [comment.id, comment]))
  switch (write.kind) {
    case 'resolve':
      return mapComments(current, (comment) => {
        const old = comment.threadId === write.params.threadId ? was.get(comment.id) : undefined
        return old ? { ...comment, isResolved: old.isResolved } : comment
      })
    case 'edit': {
      const old = was.get(write.params.commentId)
      return mapComments(current, (comment) =>
        old && comment.id === old.id ? { ...comment, body: old.body } : comment
      )
    }
    case 'delete': {
      const index = before.comments.findIndex((comment) => comment.id === write.params.commentId)
      if (index === -1 || current.comments.some((c) => c.id === write.params.commentId)) {
        return current
      }
      const comments = [...current.comments]
      comments.splice(Math.min(index, comments.length), 0, before.comments[index])
      return { ...current, comments }
    }
    case 'reply':
    case 'root':
    case 'line':
      return current
  }
}

function unconfirmed(): Error {
  return new Error(
    translate(
      'session.failure.unconfirmed',
      "Couldn't confirm whether this was sent. It hasn't been resent."
    )
  )
}

// Whether the re-read comments show this write, or undefined when they can't tell.
function writeLanded(comments: readonly PRComment[], write: PrCommentWrite): boolean | undefined {
  switch (write.kind) {
    case 'resolve': {
      const thread = comments.filter((comment) => comment.threadId === write.params.threadId)
      return thread.length > 0
        ? thread.every((comment) => (comment.isResolved === true) === write.params.resolve)
        : undefined
    }
    case 'edit': {
      const edited = comments.find((comment) => comment.id === write.params.commentId)
      return edited ? edited.body === write.params.body : undefined
    }
    case 'delete':
      // An empty list may be a read whose every source failed.
      return comments.length > 0
        ? !comments.some((comment) => comment.id === write.params.commentId)
        : undefined
    case 'reply':
    case 'root':
    case 'line':
      return undefined
  }
}

type CommentsRead = { comments: PRComment[] | null; order: number }

// Re-reads issued per details entry, and the latest one accepted: two writes' re-reads can land out of order.
const commentReads = new Map<string, { issued: number; accepted: number }>()

async function readComments(client: RpcClient, vars: PrCommentWriteVars): Promise<CommentsRead> {
  if (!vars.target) {
    return { comments: null, order: 0 }
  }
  const slot = hashKey(vars.target.key)
  const reads = commentReads.get(slot) ?? { issued: 0, accepted: 0 }
  commentReads.set(slot, reads)
  reads.issued += 1
  const order = reads.issued
  return { comments: await readPrComments(client, vars.worktreeId, vars.target.input), order }
}

// An older re-read than one already shown says nothing newer, so it is dropped.
function acceptCommentsRead(queryClient: QueryClient, key: QueryKey, read: CommentsRead): void {
  const reads = commentReads.get(hashKey(key))
  if (reads && read.order > 0 && read.order < reads.accepted) {
    return
  }
  if (reads && read.order > reads.accepted) {
    reads.accepted = read.order
  }
  acceptPrComments(queryClient, key, read.comments)
}

// A comment write re-reads only the comments: one host GitHub call instead of the whole PR.
export const prCommentWrite = defineHostMutation({
  offline: 'draft',
  send: async (client: RpcClient, vars: PrCommentWriteVars): Promise<CommentsRead> => {
    // The settle helpers report a dropped reply as a failure; keep its identity so a write the host may have
    // applied is settled by `confirm` instead of being rolled back as refused.
    let lost: Error | null = null
    const outcome = await sendWrite(
      {
        sendRequest: (method, params, options) =>
          client.sendRequest(method, params, options).catch((error: unknown) => {
            if (
              error instanceof Error &&
              (isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error))
            ) {
              lost = error
            }
            throw error
          })
      },
      vars
    )
    if (!outcome.ok) {
      throw lost ?? new Error(outcome.error)
    }
    return readComments(client, vars).catch(() => ({ comments: null, order: 0 }))
  },
  // A lost reply is settled by what the host's comments show, never by sending again. Resolve, edit and delete
  // leave a mark that can be checked; a new comment has no id yet, so its outcome stays unknown and the text stays.
  confirm: async (client: RpcClient, vars: PrCommentWriteVars): Promise<CommentsRead> => {
    const read = await readComments(client, vars).catch(() => null)
    const landed = read?.comments ? writeLanded(read.comments, vars.write) : undefined
    if (landed === false) {
      throw new Error(
        translate('session.usePrCommentActions.actionFailed', 'Comment action failed')
      )
    }
    if (landed === undefined || !read) {
      // Still unknown: keep the optimistic state rather than roll back a write that may have landed.
      throw markRpcDeliveryUnknown(unconfirmed())
    }
    return read
  },
  optimistic: {
    keys: (_hostId, vars) => (vars.target ? [vars.target.key] : []),
    apply: (queryClient, _hostId, vars) => {
      if (vars.target) {
        patchPrDetails(queryClient, vars.target.key, (details) => applyWrite(details, vars.write))
      }
    },
    revert: (queryClient, vars, snapshot) => {
      for (const [queryKey, before] of snapshot) {
        if (before) {
          patchPrDetails(queryClient, queryKey, (current) =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot holds this details entry, taken before `apply`.
            revertWrite(current, before as GitHubWorkItemDetails, vars.write)
          )
        }
      }
    }
  },
  accept: (queryClient, _hostId, vars, read) => {
    if (vars.target) {
      acceptCommentsRead(queryClient, vars.target.key, read)
    }
  }
})
