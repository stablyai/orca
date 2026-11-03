import { withGitHubRepoExecution } from '../github/github-repository-identity'
import { hostedReviewSshConnectionId } from './hosted-review-execution-host'
import { getHostedReviewLocalGitOptions } from './hosted-review-git-options'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  CreateStackedHostedReviewInput,
  CreateStackedHostedReviewResult,
  HostedReviewSummary
} from '../../shared/hosted-review'
import {
  prepareGitHubStackedPullRequest,
  registerGitHubStackedPullRequest
} from '../github/stacked-pr-creation'
import { createHostedReview } from './hosted-review-creation'
import type { HostedReviewExecutionOptions } from './hosted-review-git-options'
import { stackedReviewFailure } from '../../shared/stacked-hosted-review-failure-copy'

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
