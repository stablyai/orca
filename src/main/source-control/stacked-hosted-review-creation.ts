import { withGitHubRepoExecution } from '../github/repositories/github-repository-identity'
import { hostedReviewSshConnectionId } from './hosted-review-execution-host'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  CreateStackedHostedReviewInput,
  CreateStackedHostedReviewResult,
  HostedReviewSummary
} from '../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  prepareGitHubStackedPullRequest,
  registerGitHubStackedPullRequest
} from '../github/pull-requests/stacks/stacked-pr-creation'
import { createHostedReview } from './hosted-review-creation'

import { stackedReviewFailure } from '../../shared/source-control/hosted-review/stacked-hosted-review-failure-copy'

export async function createStackedHostedReview(
  repoPath: string,
  input: CreateStackedHostedReviewInput,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateStackedHostedReviewResult> {
  const operation = async (): Promise<CreateStackedHostedReviewResult> => {
    const plan = await prepareGitHubStackedPullRequest(repoPath, input, executionHostId, options)
    if (!plan.ok) {
      return plan
    }

    let currentReview: (HostedReviewSummary & { number: number }) | null = plan.currentReview
    if (!currentReview) {
      const created = await createHostedReview(repoPath, input, executionHostId, options)
      if (!created.ok) {
        if (!created.existingReview?.number) {
          return created
        }
        return {
          ...stackedReviewFailure('stack_existing_review_other_base'),
          createdReview: {
            number: created.existingReview.number,
            url: created.existingReview.url
          }
        }
      }
      currentReview = { number: created.number, url: created.url }
    }
    if (!currentReview) {
      return stackedReviewFailure('stack_creation_unconfirmed', {}, 'unknown_completion')
    }

    return registerGitHubStackedPullRequest({
      repoPath,
      repository: plan.repository,
      parentReview: plan.parentReview,
      currentReview,
      executionHostId,
      options
    })
  }
  return input.provider === 'github'
    ? withGitHubRepoExecution(
        repoPath,
        hostedReviewSshConnectionId(executionHostId),
        getHostedReviewLocalGitOptions(options),
        operation
      )
    : operation()
}
