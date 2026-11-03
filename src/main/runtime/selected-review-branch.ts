import type { GitPushTarget } from '../../shared/worktree/types'
import type { ForgeProviderId } from '../source-control/forge-provider'
import type { getPRForBranch } from '../github/client'

export type SelectedReviewBranchInput = {
  branchNameOverride?: string
  linkedPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  pushTarget?: GitPushTarget
}

type SelectedReviewBranch = {
  provider: ForgeProviderId
  number: number
}

export function getSelectedReviewBranch(
  args: SelectedReviewBranchInput
): SelectedReviewBranch | null {
  if (typeof args.linkedPR === 'number') {
    return { provider: 'github', number: args.linkedPR }
  }
  if (typeof args.linkedGitLabMR === 'number') {
    return { provider: 'gitlab', number: args.linkedGitLabMR }
  }
  if (typeof args.linkedBitbucketPR === 'number') {
    return { provider: 'bitbucket', number: args.linkedBitbucketPR }
  }
  if (typeof args.linkedAzureDevOpsPR === 'number') {
    return { provider: 'azure-devops', number: args.linkedAzureDevOpsPR }
  }
  if (typeof args.linkedGiteaPR === 'number') {
    return { provider: 'gitea', number: args.linkedGiteaPR }
  }
  return null
}

function isSelectedGitHubPrBranchOverride(
  args: SelectedReviewBranchInput,
  branchName: string
): boolean {
  return typeof args.linkedPR === 'number' && args.branchNameOverride === branchName
}

function isSelectedReviewBranchOverride(
  args: SelectedReviewBranchInput,
  branchName: string
): boolean {
  return getSelectedReviewBranch(args) !== null && args.branchNameOverride === branchName
}

export function isMatchingSelectedGitHubPr(
  existingPR: Awaited<ReturnType<typeof getPRForBranch>>,
  args: SelectedReviewBranchInput,
  branchName: string
): boolean {
  return Boolean(
    existingPR &&
    isSelectedGitHubPrBranchOverride(args, branchName) &&
    existingPR.number === args.linkedPR
  )
}

/** Remote conflict is checkable against the selected review: an absent push target still qualifies. */
export function isAllowedPushTargetRemoteConflict(
  conflictKind: 'local' | 'remote' | null,
  branchName: string,
  args: SelectedReviewBranchInput
): boolean {
  // Why absent is allowed: a fork PR whose push target cannot be resolved — the
  // fork was deleted, or its metadata is inaccessible — still knows the review
  // number and the head ref. Requiring a push target here made that PR take a
  // `-N` suffix, which is the behaviour #536 set out to remove ("forked PRs where
  // users would otherwise expect `gh pr checkout`-style behavior"). A push target
  // naming a *different* branch is still rejected. This only decides whether the
  // caller looks the review up; the conflict is cleared solely by that lookup
  // confirming the branch owns the selected review.
  const pushTargetMatches =
    args.pushTarget === undefined || args.pushTarget.branchName === branchName
  return (
    conflictKind === 'remote' &&
    isSelectedReviewBranchOverride(args, branchName) &&
    pushTargetMatches
  )
}

export function getSelectedReviewLookupHints(args: SelectedReviewBranchInput): {
  linkedGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
} {
  return {
    linkedGitHubPR: args.linkedPR ?? null,
    linkedGitLabMR: args.linkedGitLabMR ?? null,
    linkedBitbucketPR: args.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: args.linkedGiteaPR ?? null
  }
}
