import type { ExecutionHostId } from '../../shared/execution-host'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'
import { getGiteaRepoSlug, invalidateGiteaPullRequestScanForRepo } from './client'

/** The repository scan is shared by every branch card for 30s; a user refresh must not be answered by one from before the click. */
export async function forgetGiteaPullRequestReads(
  context: HostedReviewExecutionOptions & { repoPath: string; executionHostId: ExecutionHostId }
): Promise<void> {
  const repo = await getGiteaRepoSlug(
    context.repoPath,
    hostedReviewSshConnectionId(context.executionHostId),
    context
  )
  if (repo) {
    invalidateGiteaPullRequestScanForRepo(repo)
  }
}
