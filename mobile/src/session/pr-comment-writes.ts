import type { QueryKey } from '@tanstack/react-query'
import type { PRComment } from '../../../src/shared/github/comment-types'
import type { GitHubWorkItemDetails } from '../../../src/shared/github/work-item-types'
import { defineHostMutation } from '../query/host-mutation'
import { hostQueryKey } from '../query/host-query-key'
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
  prDetailsQuery,
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
  return queries?.detailsInput
    ? {
        key: hostQueryKey(
          queries.host.hostId,
          prDetailsQuery.family,
          queries.target,
          queries.detailsInput
        ),
        input: queries.detailsInput
      }
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

// What the write does to the shown comments before the host answers; new comments wait for the re-read.
function applyWrite(details: GitHubWorkItemDetails, write: PrCommentWrite): GitHubWorkItemDetails {
  const map = (change: (comment: PRComment) => PRComment | null): GitHubWorkItemDetails => ({
    ...details,
    comments: details.comments.flatMap((comment) => change(comment) ?? [])
  })
  switch (write.kind) {
    case 'resolve':
      return map((comment) =>
        comment.threadId === write.params.threadId
          ? { ...comment, isResolved: write.params.resolve }
          : comment
      )
    case 'edit':
      return map((comment) =>
        comment.id === write.params.commentId ? { ...comment, body: write.params.body } : comment
      )
    case 'delete':
      return map((comment) => (comment.id === write.params.commentId ? null : comment))
    default:
      return details
  }
}

function readComments(client: RpcClient, vars: PrCommentWriteVars): Promise<PRComment[] | null> {
  return vars.target
    ? readPrComments(client, vars.worktreeId, vars.target.input)
    : Promise.resolve(null)
}

// A comment write re-reads only the comments: one host GitHub call instead of the whole PR.
export const prCommentWrite = defineHostMutation({
  offline: 'draft',
  send: async (client: RpcClient, vars: PrCommentWriteVars): Promise<PRComment[] | null> => {
    const outcome = await sendWrite(client, vars)
    if (!outcome.ok) {
      throw new Error(outcome.error)
    }
    return readComments(client, vars).catch(() => null)
  },
  // A lost reply is settled by what the host's comments show, never by posting again.
  confirm: readComments,
  optimistic: {
    keys: (_hostId, vars) => (vars.target ? [vars.target.key] : []),
    apply: (queryClient, _hostId, vars) => {
      if (vars.target) {
        patchPrDetails(queryClient, vars.target.key, (details) => applyWrite(details, vars.write))
      }
    }
  },
  accept: (queryClient, _hostId, vars, comments) => {
    if (vars.target) {
      acceptPrComments(queryClient, vars.target.key, comments)
    }
  }
})
