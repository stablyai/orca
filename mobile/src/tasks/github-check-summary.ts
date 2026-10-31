import { summarizeProviderChecks } from '../../../src/shared/provider-check-summary'
import type { ProviderCheckSummary } from '../../../src/shared/github/pull-request-types'

export type GitHubCheckLike = {
  status: string
  conclusion?: string | null
}

export type GitHubCheckSummary = ProviderCheckSummary

// Use the desktop classifier so skipped checks cannot disagree across mobile and desktop.
export function buildGitHubCheckSummary(checks: GitHubCheckLike[]): GitHubCheckSummary {
  return summarizeProviderChecks(checks)
}
