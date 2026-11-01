import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { GitHubPRBranchLookupOptions } from './pull-request-lookup-data'
import { getPRForBranchOutcome } from './pr-for-branch-outcome'
/** Linked PR numbers are authoritative; fallback numbers apply only after branch lookup misses. */
export async function getPRForBranch(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  fallbackPRNumber?: number | null,
  options: GitHubPRBranchLookupOptions = {}
): Promise<PRInfo | null> {
  const outcome = await getPRForBranchOutcome(
    repoPath,
    branch,
    linkedPRNumber,
    connectionId,
    fallbackPRNumber,
    options
  )
  return outcome.kind === 'found' ? outcome.pr : null
}
