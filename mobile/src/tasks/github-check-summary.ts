import { summarizeProviderChecks } from '../../../src/shared/provider-check-summary'
import type { ProviderCheckSummary } from '../../../src/shared/types'

export type GitHubCheckLike = {
  status: string
  conclusion?: string | null
}

export type GitHubCheckSummary = ProviderCheckSummary

// Why: reuse the desktop classifier verbatim — a second copy is what let mobile call `skipped`
// unresolved while desktop called the same PR green.
export function buildGitHubCheckSummary(checks: GitHubCheckLike[]): GitHubCheckSummary {
  return summarizeProviderChecks(checks)
}
