import { getRepoExecutionHostId } from '../../shared/execution-host'
import { invalidateHostedReviewBranchCache } from '../source-control/hosted-review-branch-cache'

// A post-mutation refresh must not join an older lookup or reuse its cached answer.
export function invalidateReviewLookupsAfterPRMutation(
  repoPath: string,
  connectionId: string | null | undefined
): void {
  invalidateHostedReviewBranchCache(repoPath, getRepoExecutionHostId({ connectionId }))
}
