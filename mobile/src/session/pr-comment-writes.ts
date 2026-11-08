import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { PRComment } from '../../../src/shared/github/comment-types'
import type { GitHubWorkItemDetails } from '../../../src/shared/github/work-item-types'
import { defineHostMutation } from '../query/host-mutation'
import { translate } from '../i18n/mobile-i18n'
import { isLogicalClientCutoverError } from '../transport/logical-client-cutover-error'
import type { RpcClient } from '../transport/rpc-client'
import {
  fetchAddIssueComment,
  fetchAddPRReviewCommentReply,
  fetchDeleteIssueComment,
  fetchResolveReviewThread,
  fetchUpdateIssueComment,
  type GitHubPrMutationOutcome
} from './github-pr-mutations'
import { fetchAddPRReviewComment } from './github-pr-review-line-mutations'
import type { GitHubPrRepoSlug } from './github-pr-rpc'
import {
  acceptPrComments,
  patchPrDetails,
  prQueryKeys,
  readPrComments,
  type PrDetailsInput,
  type PrQueryScope
} from './mobile-pr-queries'
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

function sendWrite(client: RpcClient, vars: PrCommentWriteVars): Promise<GitHubPrMutationOutcome> {
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
    const outcome = await sendWrite(client, vars)
    if (!outcome.ok) {
      // A path switch mid-send may or may not have delivered it: say so, and keep the typed text.
      throw isLogicalClientCutoverError(new Error(outcome.error))
        ? unconfirmed()
        : new Error(outcome.error)
    }
    return readComments(client, vars).catch(() => ({ comments: null, order: 0 }))
  },
  // The comments can't prove a lost write landed (a new comment has no id yet, and an empty list may be a
  // failed read), so a lost reply is reported as unknown rather than success, and never posted again.
  confirm: () => Promise.reject(unconfirmed()),
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
