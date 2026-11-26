import type { ForgeProvider } from '../source-control/forge-provider'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
import { getHostedReviewLocalGitOptions } from '../source-control/hosted-review-git-options'
import {
  getNgitPullRequestForBranchOrThrow,
  getNgitRepoSlug,
  mapNgitPullRequestToReview
} from './pull-request-lookup'
import { createNgitPullRequest } from './pull-request-creation'

export const ngitForgeProvider = {
  id: 'ngit',
  supportsReviewCreation: true,
  resolveRepository: (context) =>
    getNgitRepoSlug(
      context.repoPath,
      hostedReviewSshConnectionId(context.executionHostId),
      getHostedReviewLocalGitOptions(context)
    ),
  async getReviewForBranch(input) {
    // An unanswered relay read is unavailable, never proof no pull request exists.
    const pull = await getNgitPullRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      hostedReviewSshConnectionId(input.executionHostId),
      input
    )
    return pull ? mapNgitPullRequestToReview(pull) : null
  },
  async getReviewByNumber(input) {
    const pull = await getNgitPullRequestForBranchOrThrow(
      input.repoPath,
      '',
      input.number,
      hostedReviewSshConnectionId(input.executionHostId),
      input
    )
    return pull ? mapNgitPullRequestToReview(pull) : null
  },
  createReview: createNgitPullRequest
} satisfies ForgeProvider
