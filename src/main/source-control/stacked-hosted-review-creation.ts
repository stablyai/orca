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

export async function createStackedHostedReview(
  repoPath: string,
  input: CreateStackedHostedReviewInput,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateStackedHostedReviewResult> {
  const plan = await prepareGitHubStackedPullRequest(repoPath, input, connectionId, options)
  if (!plan.ok) {
    return plan
  }

  let currentReview: (HostedReviewSummary & { number: number }) | null = plan.currentReview
  if (!currentReview) {
    const created = await createHostedReview(repoPath, input, connectionId, options)
    if (!created.ok) {
      if (!created.existingReview?.number) {
        return created
      }
      return {
        ok: false,
        code: 'validation',
        error:
          'An open pull request already exists for this branch but does not target the selected parent branch.',
        createdReview: {
          number: created.existingReview.number,
          url: created.existingReview.url
        }
      }
    }
    currentReview = { number: created.number, url: created.url }
  }
  if (!currentReview) {
    return {
      ok: false,
      code: 'unknown_completion',
      error: 'Pull request creation may have completed. Retry to finish stack registration.'
    }
  }

  return registerGitHubStackedPullRequest({
    repoPath,
    repository: plan.repository,
    parentReview: plan.parentReview,
    currentReview,
    connectionId,
    options
  })
}
