import type { GitHubPRMergeMethod } from '../../../src/shared/github/pull-request-types'
import {
  githubPrAutoMergeSet,
  githubPrChecksRerun,
  githubPrIssueCommentAdd,
  githubPrIssueCommentDelete,
  githubPrIssueCommentEdit,
  githubPrMergeRun,
  githubPrReviewCommentReplyAdd,
  githubPrReviewersRemove,
  githubPrReviewersRequest,
  githubPrReviewThreadResolve,
  githubPrStateSet,
  githubPrTitleSet
} from './github-pr-mutation-operations'
import {
  settleGithubPrConfirmation,
  settleGithubPrMutation,
  type GitHubPrMutationOutcome
} from './github-pr-mutation-outcome'
import {
  githubPrRepoSlugParam,
  githubPrRequestParams,
  type GitHubPrRepoSlug
} from './github-pr-repo-slug'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

// The github.* PR mutation surface: merge, auto-merge, open/close, reviewers, check reruns, the
// inline title edit, and the conversation mutations (thread replies, root comments, resolution,
// slug-addressed comment edit/delete). Each wrapper builds params and hands the bound operation to
// the settle shape its host reply contract calls for.

export type { GitHubPrMutationOutcome } from './github-pr-mutation-outcome'

export function fetchMergePR(
  client: RpcOperationSender,
  worktreeId: string,
  args: { prNumber: number; method?: GitHubPRMergeMethod; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = { prNumber: args.prNumber }
  if (args.method) {
    params.method = args.method
  }
  return settleGithubPrMutation(githubPrMergeRun, () =>
    githubPrMergeRun.request(
      client,
      githubPrRequestParams(githubPrMergeRun.operation.method, worktreeId, params, {
        prRepo: args.prRepo
      })
    )
  )
}

// Edit the hosted-review title. The host returns a bare boolean (true on success),
// so it takes the confirmation shape rather than the status envelope.
export function fetchUpdatePRTitle(
  client: RpcOperationSender,
  worktreeId: string,
  args: { prNumber: number; title: string; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = { prNumber: args.prNumber, title: args.title }
  return settleGithubPrConfirmation(
    githubPrTitleSet,
    () =>
      githubPrTitleSet.request(
        client,
        githubPrRequestParams(githubPrTitleSet.operation.method, worktreeId, params, {
          prRepo: args.prRepo
        })
      ),
    'Failed to update title.'
  )
}

export function fetchSetPRAutoMerge(
  client: RpcOperationSender,
  worktreeId: string,
  args: {
    prNumber: number
    enabled: boolean
    method?: GitHubPRMergeMethod
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = { prNumber: args.prNumber, enabled: args.enabled }
  if (args.method) {
    params.method = args.method
  }
  return settleGithubPrMutation(githubPrAutoMergeSet, () =>
    githubPrAutoMergeSet.request(
      client,
      githubPrRequestParams(githubPrAutoMergeSet.operation.method, worktreeId, params, {
        prRepo: args.prRepo
      })
    )
  )
}

export function fetchUpdatePRState(
  client: RpcOperationSender,
  worktreeId: string,
  args: { prNumber: number; state: 'open' | 'closed'; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  return settleGithubPrMutation(githubPrStateSet, () =>
    githubPrStateSet.request(
      client,
      githubPrRequestParams(
        githubPrStateSet.operation.method,
        worktreeId,
        { prNumber: args.prNumber, updates: { state: args.state } },
        { prRepo: args.prRepo }
      )
    )
  )
}

export function fetchRequestPRReviewers(
  client: RpcOperationSender,
  worktreeId: string,
  args: { prNumber: number; reviewers: string[]; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  return settleGithubPrMutation(githubPrReviewersRequest, () =>
    githubPrReviewersRequest.request(
      client,
      githubPrRequestParams(
        githubPrReviewersRequest.operation.method,
        worktreeId,
        { prNumber: args.prNumber, reviewers: args.reviewers },
        { prRepo: args.prRepo }
      )
    )
  )
}

export function fetchRemovePRReviewers(
  client: RpcOperationSender,
  worktreeId: string,
  args: { prNumber: number; reviewers: string[]; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  return settleGithubPrMutation(githubPrReviewersRemove, () =>
    githubPrReviewersRemove.request(
      client,
      githubPrRequestParams(
        githubPrReviewersRemove.operation.method,
        worktreeId,
        { prNumber: args.prNumber, reviewers: args.reviewers },
        { prRepo: args.prRepo }
      )
    )
  )
}

export function fetchRerunPRChecks(
  client: RpcOperationSender,
  worktreeId: string,
  args: {
    prNumber: number
    headSha?: string | null
    failedOnly?: boolean
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = { prNumber: args.prNumber }
  if (args.failedOnly !== undefined) {
    params.failedOnly = args.failedOnly
  }
  if (args.headSha) {
    params.headSha = args.headSha
  }
  return settleGithubPrMutation(githubPrChecksRerun, () =>
    githubPrChecksRerun.request(
      client,
      githubPrRequestParams(githubPrChecksRerun.operation.method, worktreeId, params, {
        prRepo: args.prRepo
      })
    )
  )
}

// Reply within a review thread. Host returns GitHubCommentResult
// (`{ ok, comment } | { ok:false, error }`), which the status reader admits.
// We refetch afterward, so the returned comment is unused.
export function fetchAddPRReviewCommentReply(
  client: RpcOperationSender,
  worktreeId: string,
  args: {
    prNumber: number
    commentId: number
    body: string
    threadId?: string
    path?: string
    line?: number
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = {
    prNumber: args.prNumber,
    commentId: args.commentId,
    body: args.body
  }
  if (args.threadId) {
    params.threadId = args.threadId
  }
  if (args.path) {
    params.path = args.path
  }
  if (typeof args.line === 'number') {
    params.line = args.line
  }
  return settleGithubPrMutation(githubPrReviewCommentReplyAdd, () =>
    githubPrReviewCommentReplyAdd.request(
      client,
      githubPrRequestParams(githubPrReviewCommentReplyAdd.operation.method, worktreeId, params, {
        prRepo: args.prRepo
      })
    )
  )
}

// Add a root conversation comment to the PR. Host returns GitHubCommentResult.
export function fetchAddIssueComment(
  client: RpcOperationSender,
  worktreeId: string,
  args: { prNumber: number; body: string; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = {
    number: args.prNumber,
    body: args.body,
    type: 'pr'
  }
  return settleGithubPrMutation(githubPrIssueCommentAdd, () =>
    githubPrIssueCommentAdd.request(
      client,
      githubPrRequestParams(githubPrIssueCommentAdd.operation.method, worktreeId, params, {
        prRepo: args.prRepo
      })
    )
  )
}

// Resolve/unresolve a review thread. `resolve` picks the direction (the host runs
// the matching GraphQL mutation). Unlike the comment mutations, the host returns a
// bare boolean, so a falsy result is a failure rather than the "no status" success.
export function fetchResolveReviewThread(
  client: RpcOperationSender,
  worktreeId: string,
  args: { threadId: string; resolve: boolean; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  return settleGithubPrConfirmation(
    githubPrReviewThreadResolve,
    () =>
      githubPrReviewThreadResolve.request(
        client,
        githubPrRequestParams(
          githubPrReviewThreadResolve.operation.method,
          worktreeId,
          { threadId: args.threadId, resolve: args.resolve },
          { prRepo: args.prRepo }
        )
      ),
    'Failed to update review thread.'
  )
}

// Edit a root conversation (issue) comment. The host RPC is slug-addressed
// (owner/repo/commentId), not worktree-addressed, so the params are passed
// directly rather than via the PR-scoped builder. Host returns the
// GitHubProjectMutationResult `{ ok }` envelope the status reader admits.
export function fetchUpdateIssueComment(
  client: RpcOperationSender,
  args: { owner: string; repo: string; host?: string; commentId: number; body: string }
): Promise<GitHubPrMutationOutcome> {
  return settleGithubPrMutation(githubPrIssueCommentEdit, () =>
    githubPrIssueCommentEdit.request(client, {
      ...githubPrRepoSlugParam(args),
      commentId: args.commentId,
      body: args.body
    })
  )
}

// Delete a root conversation (issue) comment. Slug-addressed like the edit wrapper.
export function fetchDeleteIssueComment(
  client: RpcOperationSender,
  args: { owner: string; repo: string; host?: string; commentId: number }
): Promise<GitHubPrMutationOutcome> {
  return settleGithubPrMutation(githubPrIssueCommentDelete, () =>
    githubPrIssueCommentDelete.request(client, {
      ...githubPrRepoSlugParam(args),
      commentId: args.commentId
    })
  )
}
