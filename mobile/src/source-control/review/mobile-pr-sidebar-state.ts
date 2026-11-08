import {
  resolveGitHubWorkItemTarget,
  githubWorkItemTargetKey
} from '../../../../src/shared/github/work-item-target'
import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import type { GitPushTarget } from '../../../../src/shared/worktree/types'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import type { HostedReviewInfo } from '../../../../src/shared/source-control/hosted-review/hosted-review-contracts'
import type { GitHubPrReadOutcome } from './github-pr-rpc'
import { isGitHubPRSuppressed } from '../../../../src/shared/worktree/github-pr-suppression'
import {
  shouldApplyBranchMismatchedLinkedPRClear,
  shouldApplyDivergedLinkedPRClear,
  shouldClearBranchMismatchedLinkedOpenPR,
  shouldClearDivergedLinkedMergedPR
} from '../../../../src/shared/github/linked-pr-staleness'
import type { MobileWorktreeSummary } from '../mobile-worktree-metadata-operations'
import type { WorktreeGitHubPRLink } from '../mobile-pr-link'
import { translate } from '../../i18n/mobile-i18n'

export type PrSidebarData = {
  pr: PRInfo
  details: GitHubWorkItemDetails | null
  checks: PRCheckDetail[]
  // Contain check failures so the remaining PR controls still render.
  checksError: string | null
  // Source Control gates pushes on the review's own push target, as desktop does.
  pushTarget: GitPushTarget | null
}

// Separate permanent auth/permission failures from transient errors to avoid endless revert/retry loops.
export type PrSidebarState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  // refreshFailed: a current PR read failed while this accepted result stayed on screen.
  | { kind: 'ready'; data: PrSidebarData; refreshFailed?: true }
  | { kind: 'none'; refreshFailed?: true }
  | { kind: 'error'; message: string }
  | { kind: 'blocked'; message: string }

// The wire shares an error-string shape; classify permanent failures before offering retry.
const PERMANENT_FAILURE_PATTERN =
  /\b(not connected|no github|unauthenticated|not authenticated|gh auth|login|permission|forbidden|insufficient|401|403|404)\b/i

export function classifyPrSidebarFailure(message: string): 'blocked' | 'error' {
  return PERMANENT_FAILURE_PATTERN.test(message) ? 'blocked' : 'error'
}

function failureState(
  message: string
): { kind: 'error'; message: string } | { kind: 'blocked'; message: string } {
  return classifyPrSidebarFailure(message) === 'blocked'
    ? { kind: 'blocked', message }
    : { kind: 'error', message }
}

export type PrSidebarLoadDeps = {
  fetchForBranch: (
    worktreeId: string,
    args: { branch: string; linkedGitHubPR?: number | null }
  ) => Promise<GitHubPrReadOutcome<HostedReviewInfo | null>>
  // Resolve persisted links in parallel so closed/merged PRs add no serial read.
  fetchWorktreeGitHubPRLink: (worktreeId: string) => Promise<WorktreeGitHubPRLink>
  clearWorktreeReviewLink: (
    worktreeId: string,
    shouldApply: (worktree: MobileWorktreeSummary) => boolean
  ) => Promise<void>
  fetchPRForBranch: (
    worktreeId: string,
    args: {
      branch: string
      linkedPRNumber?: number | null
      fallbackPRNumber?: number | null
      currentHeadOid?: string | null
      refresh?: boolean
    }
  ) => Promise<GitHubPrReadOutcome<PRInfo | null>>
}

// The guard desktop applies before persisting the clear, or null when the link still holds.
function resolveStaleLink(
  pr: PRInfo | null,
  link: WorktreeGitHubPRLink,
  branch: string,
  requestHeadOid: string | null
): ((worktree: MobileWorktreeSummary) => boolean) | null {
  const linkedPRNumber = link.linkedPR
  if (linkedPRNumber === null) {
    return null
  }
  if (shouldClearDivergedLinkedMergedPR({ pr, linkedPRNumber, requestHeadOid })) {
    return (worktree) =>
      shouldApplyDivergedLinkedPRClear({ worktree, linkedPRNumber, branch, requestHeadOid })
  }
  const pushTargetBranch = link.pushTarget?.branchName ?? null
  if (
    shouldClearBranchMismatchedLinkedOpenPR({
      pr,
      linkedPRNumber,
      branch,
      requestHeadOid,
      pushTargetBranch
    })
  ) {
    return (worktree) =>
      shouldApplyBranchMismatchedLinkedPRClear({ worktree, linkedPRNumber, branch, requestHeadOid })
  }
  return null
}

/** The branch's GitHub review: its PR and the workspace's push target, or none. */
export type PrBranchReview =
  | { kind: 'found'; pr: PRInfo; pushTarget: GitPushTarget | null }
  | { kind: 'none' }

// Parallel link resolution also retains closed/merged reviews. A failed read throws its message, classified when shown.
export async function loadPrBranchReview(
  deps: PrSidebarLoadDeps,
  args: {
    worktreeId: string
    branch: string
    headSha?: string | null
    refresh?: boolean
  }
): Promise<PrBranchReview> {
  const [hintOutcome, link] = await Promise.all([
    deps.fetchForBranch(args.worktreeId, { branch: args.branch }),
    deps.fetchWorktreeGitHubPRLink(args.worktreeId)
  ])
  const branchHint =
    hintOutcome.ok && hintOutcome.result?.provider === 'github' ? hintOutcome.result.number : null

  const requestHeadOid = args.headSha ?? null
  // Same as desktop: the explicit link wins; the branch's review is only a fallback.
  const fetchPR = (linkedPRNumber: number | null) =>
    deps.fetchPRForBranch(args.worktreeId, {
      branch: args.branch,
      linkedPRNumber,
      fallbackPRNumber: linkedPRNumber === null ? branchHint : null,
      currentHeadOid: requestHeadOid,
      ...(args.refresh ? { refresh: true } : {})
    })
  let linkedPR = link.linkedPR
  let prOutcome = await fetchPR(linkedPR)
  const staleLink = prOutcome.ok
    ? resolveStaleLink(prOutcome.result, link, args.branch, requestHeadOid)
    : null
  // Desktop drops a link the branch has moved past, then resolves by branch.
  if (staleLink) {
    linkedPR = null
    // The refetch sends no link, so it need not wait for the clear to land.
    ;[, prOutcome] = await Promise.all([
      deps.clearWorktreeReviewLink(args.worktreeId, staleLink),
      fetchPR(null)
    ])
  }
  if (!prOutcome.ok) {
    throw new Error(prOutcome.error)
  }
  if (
    !prOutcome.result ||
    isGitHubPRSuppressed(
      { linkedPR, suppressedGitHubPR: link.suppressedGitHubPR },
      prOutcome.result.number
    )
  ) {
    return { kind: 'none' }
  }
  return { kind: 'found', pr: prOutcome.result, pushTarget: link.pushTarget }
}

// What the screen shows for a PR read that failed with nothing accepted to keep.
export function prSidebarFailureState(
  error: unknown
): { kind: 'error'; message: string } | { kind: 'blocked'; message: string } {
  return error instanceof Error
    ? failureState(error.message)
    : {
        kind: 'error',
        message: translate('session.prSidebarState.loadFailed', 'Unable to load pull request')
      }
}

export function emptyPrSidebarDetails(pr: PRInfo): GitHubWorkItemDetails {
  return {
    item: {
      id: `pr-${pr.number}`,
      type: 'pr',
      number: pr.number,
      title: pr.title,
      state: pr.state,
      url: pr.url,
      labels: [],
      updatedAt: pr.updatedAt,
      author: null
    },
    body: '',
    comments: []
  }
}

export function isPrSidebarDetailsPlaceholder(details: GitHubWorkItemDetails): boolean {
  return details.item.id === `pr-${details.item.number}`
}

// Retry synthetic failed-fetch placeholders, but never refetch a real empty body as though it were missing.
export function prSidebarDetailsNeedFetch(
  details: GitHubWorkItemDetails | null | undefined
): boolean {
  return details == null || isPrSidebarDetailsPlaceholder(details)
}

export function prSidebarResourceKey(pr: PRInfo): string {
  const target = resolveGitHubWorkItemTarget({ ...pr, type: 'pr' })
  return target ? githubWorkItemTargetKey(target) : pr.url
}
