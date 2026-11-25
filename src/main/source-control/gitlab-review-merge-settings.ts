import type { HostedReviewInfo } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import type { MRInfo } from '../../shared/gitlab/gitlab-types'
import { getGitLabProjectMergeMethodSettings } from '../gitlab/projects/gitlab-project-merge-settings'
import { mapGitLabReview } from './forge-review-mappers'
import { hostedReviewSshConnectionId } from './hosted-review-execution-host'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'
import type { ExecutionHostId } from '../../shared/execution-host/execution-host'

// Read after the MR lookup releases its admission slot; only open MRs can be merged.
export async function withGitLabMergeMethodSettings(
  mr: MRInfo,
  context: HostedReviewExecutionOptions & { repoPath: string; executionHostId: ExecutionHostId }
): Promise<HostedReviewInfo> {
  const review = mapGitLabReview(mr)
  if (review.state !== 'open') {
    return review
  }
  const mergeMethodSettings = await getGitLabProjectMergeMethodSettings(
    context.repoPath,
    hostedReviewSshConnectionId(context.executionHostId),
    getHostedReviewLocalGitOptions(context)
  )
  return mergeMethodSettings ? { ...review, mergeMethodSettings } : review
}
