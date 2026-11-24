import type { GitHubPRMergeMethod } from '../../../../../../src/shared/github/pull-requests/pull-request-types'
import type { GitHubPrMutationOutcome } from '../../github-operations/github-pr-mutation-outcome'
import type { GitHubPrRepoSlug } from '../../github-operations/github-pr-repo-slug'

export type PrActionMutations = {
  mergePR: (args: {
    prNumber: number
    method?: GitHubPRMergeMethod
    prRepo?: GitHubPrRepoSlug | null
    /** The PR head on screen; the host refuses the merge if GitHub's head moved past it. */
    expectedHeadSha?: string | null
  }) => Promise<GitHubPrMutationOutcome>
  setPRAutoMerge: (args: {
    prNumber: number
    enabled: boolean
    method?: GitHubPRMergeMethod
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  updatePRState: (args: {
    prNumber: number
    state: 'open' | 'closed'
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  markReadyForReview: (args: {
    prNumber: number
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  markDraft: (args: {
    prNumber: number
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  requestReviewers: (args: {
    prNumber: number
    reviewers: string[]
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  removeReviewers: (args: {
    prNumber: number
    reviewers: string[]
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  rerunChecks: (args: {
    prNumber: number
    headSha?: string | null
    failedOnly?: boolean
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
}
