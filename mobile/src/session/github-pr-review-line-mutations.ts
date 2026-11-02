import { githubPrFileViewedSet, githubPrReviewCommentAdd } from './github-pr-mutation-operations'
import {
  settleGithubPrConfirmation,
  settleGithubPrMutation,
  type GitHubPrMutationOutcome
} from './github-pr-mutation-outcome'
import { githubPrRequestParams, type GitHubPrRepoSlug } from './github-pr-repo-slug'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { translate } from '../i18n/mobile-i18n'

// The diff screen's writes on a PR file: a new line comment and its viewed mark.

// A new line comment on the PR's head commit; GitHub only accepts lines inside the file's diff hunks.
export function fetchAddPRReviewComment(
  client: RpcOperationSender,
  worktreeId: string,
  args: {
    prNumber: number
    commitId: string
    path: string
    line: number
    startLine?: number
    body: string
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = {
    prNumber: args.prNumber,
    commitId: args.commitId,
    path: args.path,
    line: args.line,
    body: args.body
  }
  if (args.startLine !== undefined && args.startLine !== args.line) {
    params.startLine = args.startLine
  }
  return settleGithubPrMutation(githubPrReviewCommentAdd, () =>
    githubPrReviewCommentAdd.request(
      client,
      githubPrRequestParams(githubPrReviewCommentAdd.operation.method, worktreeId, params, {
        prRepo: args.prRepo
      })
    )
  )
}

export function fetchSetPRFileViewed(
  client: RpcOperationSender,
  worktreeId: string,
  args: {
    pullRequestId: string
    path: string
    viewed: boolean
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<GitHubPrMutationOutcome> {
  return settleGithubPrConfirmation(
    githubPrFileViewedSet,
    () =>
      githubPrFileViewedSet.request(
        client,
        githubPrRequestParams(
          githubPrFileViewedSet.operation.method,
          worktreeId,
          { pullRequestId: args.pullRequestId, path: args.path, viewed: args.viewed },
          { prRepo: args.prRepo }
        )
      ),
    translate('session.githubPrMutations.fileViewedFailed', 'Failed to update viewed state.')
  )
}
