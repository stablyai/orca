import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { GitHubPRBranchLookupOptions } from './pull-request-lookup-data'
import { getPRForBranchOutcome } from './pr-for-branch-outcome'
/**
 * Get PR info for a given branch using gh CLI.
 * Returns null if gh is not installed, or no PR exists for the branch.
 *
 * When `linkedPRNumber` is provided, it is the source of truth. This handles
 * "create from PR" worktrees whose local branch differs from the PR head ref,
 * and prevents a coalesced linked-PR refresh from fanning out an unrelated
 * branch lookup result to sibling aliases.
 * `fallbackPRNumber` is weaker: branch lookup still wins, and exact lookup is
 * used only after branch lookup misses.
 */
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
