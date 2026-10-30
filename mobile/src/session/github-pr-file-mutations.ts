import { githubPullRequestFileViewedWrite as githubPrFileViewedSet } from '../tasks/mobile-task-item-state-operations'
import {
  settleGithubPrConfirmation,
  type GitHubPrMutationOutcome
} from './github-pr-mutation-outcome'
import { githubPrRequestParams, type GitHubPrRepoSlug } from './github-pr-repo-slug'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { translate } from '../i18n/mobile-i18n'

export function fetchSetPRFileViewed(
  client: RpcOperationSender,
  worktreeId: string,
  args: { pullRequestId: string; path: string; viewed: boolean; prRepo?: GitHubPrRepoSlug | null }
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
        ),
        { timeoutMs: 30_000 }
      ),
    translate(
      'session.githubPrFileMutations.viewedSyncFailed',
      'Failed to sync viewed state with GitHub.'
    )
  )
}
