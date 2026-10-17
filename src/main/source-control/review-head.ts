import { readReviewHead, type ReviewHead } from '../../shared/git-review-head'
import { getRepoGitConfigSnapshot, type RepoGitConfigOptions } from './repo-git-config-snapshot'

export type BranchReviewHead = Extract<ReviewHead, { kind: 'branch' }>

/**
 * What a branch lookup asks the provider for. An explicit link wins without reading git; a branch
 * checked out from a review links itself; any other branch is matched by where it is pushed
 * (#27811, #26948). `head` is null for a detached HEAD.
 */
export async function resolveBranchReviewTarget(
  repoPath: string,
  branch: string,
  linkedNumber: number | null | undefined,
  connectionId?: string | null,
  options: RepoGitConfigOptions = {}
): Promise<{ linkedNumber: number | null; head: BranchReviewHead | null }> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (typeof linkedNumber === 'number' || !branchName) {
    return { linkedNumber: linkedNumber ?? null, head: null }
  }
  const config = await getRepoGitConfigSnapshot(repoPath, connectionId, options)
  // Why: an unreadable config defaults to `origin/<branch>` rather than hiding the review.
  const head = readReviewHead(config ?? new Map(), branchName)
  return head.kind === 'review'
    ? { linkedNumber: head.number, head: null }
    : { linkedNumber: null, head }
}
