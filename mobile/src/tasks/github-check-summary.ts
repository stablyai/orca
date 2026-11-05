import { summarizeProviderChecks } from '../../../src/shared/source-control/checks/provider-check-summary'
import type { ProviderCheckSummary } from '../../../src/shared/github/pull-request-types'

export type GitHubCheckLike = {
  status: string
  conclusion?: string | null
}

export type GitHubCheckSummary = ProviderCheckSummary

// Use the desktop classifier so skipped checks cannot disagree across mobile and desktop.
export function buildGitHubCheckSummary(checks: GitHubCheckLike[]): GitHubCheckSummary {
  const summary = summarizeProviderChecks(checks)
  // Detail lists do not prove completeness; only whole-PR reads publish cancellation metadata.
  delete summary.cancelled
  return summary
}
