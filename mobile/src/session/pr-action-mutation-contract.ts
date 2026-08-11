import type { GitHubPRMergeMethod } from '../../../src/shared/types'
import type { GitHubPrMutationOutcome } from './github-pr-mutations'
import type { GitHubPrRepoSlug } from './github-pr-rpc'

export type PrActionMutations = {
  mergePR: (args: {
    prNumber: number
    method?: GitHubPRMergeMethod
    prRepo?: GitHubPrRepoSlug | null
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
