import {
  mapAzureDevOpsPullRequestState,
  type RawAzureDevOpsPullRequest
} from './pull-request-mappers'
import { shouldHideMergedImplicitReview } from '../source-control/branch-review-selection'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../source-control/repo-default-branch'
import { readCurrentReviewHead } from '../source-control/review-current-head'
import type { HostedReviewLocalGitOptions } from '../source-control/hosted-review-git-options'

function sortPullRequestsForBranch(
  left: RawAzureDevOpsPullRequest,
  right: RawAzureDevOpsPullRequest
): number {
  const leftStatus = left.status?.trim().toLowerCase()
  const rightStatus = right.status?.trim().toLowerCase()
  const abandonedOrder = Number(leftStatus === 'abandoned') - Number(rightStatus === 'abandoned')
  // Newer abandoned PRs must not hide usable branch reviews.
  if (abandonedOrder !== 0) {
    return abandonedOrder
  }
  const leftTime = Date.parse(left.closedDate ?? left.creationDate ?? '') || 0
  const rightTime = Date.parse(right.closedDate ?? right.creationDate ?? '') || 0
  if (leftTime !== rightTime) {
    return rightTime - leftTime
  }
  return Number(rightStatus === 'active') - Number(leftStatus === 'active')
}

/**
 * Picks the raw pull request a branch's review should show. A completed PR
 * must not keep claiming a reused branch name: like GitLab's stale
 * merged-review hiding, an implicit merged match survives only while the local
 * branch head still equals its last source commit, and hiding it must not keep
 * a usable active review behind it hidden.
 */
export async function selectBranchPullRequestCandidate(
  candidates: RawAzureDevOpsPullRequest[],
  input: {
    branchName: string
    linkedPRNumber: number | null | undefined
    repoPath: string
    connectionId: string | null | undefined
    localGitOptions: HostedReviewLocalGitOptions
  }
): Promise<RawAzureDevOpsPullRequest | null> {
  const sorted = [...candidates].sort(sortPullRequestsForBranch)
  for (const raw of sorted) {
    const hideOnDefaultBranch = await shouldHideNonOpenReviewOnDefaultBranch({
      state: mapAzureDevOpsPullRequestState(raw),
      reviewNumber: raw.pullRequestId ?? null,
      linkedReviewNumber: input.linkedPRNumber,
      branchName: input.branchName,
      repoPath: input.repoPath,
      connectionId: input.connectionId,
      localGitOptions: input.localGitOptions
    })
    if (hideOnDefaultBranch) {
      continue
    }
    if (await shouldHideStaleCompletedPullRequest(raw, input)) {
      continue
    }
    return raw
  }
  return null
}

async function shouldHideStaleCompletedPullRequest(
  raw: RawAzureDevOpsPullRequest,
  input: {
    linkedPRNumber: number | null | undefined
    repoPath: string
    connectionId: string | null | undefined
    localGitOptions: HostedReviewLocalGitOptions
  }
): Promise<boolean> {
  // An explicit link exempts only its own PR; any other completed candidate
  // stays an implicit match, so a stale sibling cannot shadow the linked review.
  if (
    (typeof input.linkedPRNumber === 'number' && raw.pullRequestId === input.linkedPRNumber) ||
    mapAzureDevOpsPullRequestState(raw) !== 'merged'
  ) {
    return false
  }
  // The repoPath is remote, so a local rev-parse could answer for the wrong repo.
  if (input.connectionId) {
    return false
  }
  return shouldHideMergedImplicitReview(
    'merged',
    // The linked number exempts only its own PR (handled above); a non-matching
    // candidate reaching this point is an implicit match.
    null,
    raw.lastMergeSourceCommit?.commitId?.trim() ?? null,
    await readCurrentReviewHead(input.repoPath, input.connectionId, input.localGitOptions)
  )
}
