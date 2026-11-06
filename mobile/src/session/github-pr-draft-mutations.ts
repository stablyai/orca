import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { githubPrRequestParams, type GitHubPrRepoSlug } from './github-pr-repo-slug'
import { githubPrDraftMark, githubPrReadyForReviewMark } from './github-pr-mutation-operations'
import { settleGithubPrMutation, type GitHubPrMutationOutcome } from './github-pr-mutation-outcome'

// Ready for review and Mark as draft: the same toggle on GitHub, one RPC each.
export function fetchMarkPRReadyForReview(
  client: RpcOperationSender,
  worktreeId: string,
  args: { prNumber: number; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  return settleGithubPrMutation(githubPrReadyForReviewMark, () =>
    githubPrReadyForReviewMark.request(
      client,
      githubPrRequestParams(
        'github.markPRReadyForReview',
        worktreeId,
        { prNumber: args.prNumber },
        args
      )
    )
  )
}

export function fetchMarkPRDraft(
  client: RpcOperationSender,
  worktreeId: string,
  args: { prNumber: number; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  return settleGithubPrMutation(githubPrDraftMark, () =>
    githubPrDraftMark.request(
      client,
      githubPrRequestParams('github.markPRDraft', worktreeId, { prNumber: args.prNumber }, args)
    )
  )
}
