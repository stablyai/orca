import type { PRCheckDetail } from '../../../src/shared/github/check-types'
import type { PRInfo } from '../../../src/shared/github/pull-request-types'
import type { GitPushTarget } from '../../../src/shared/worktree/types'
import type { GitHubWorkItemDetails } from '../../../src/shared/github/work-item-types'
import type { GitHubPrReadOutcome, GitHubPrRepoSlug } from './github-pr-rpc'
import { isGitHubPRSuppressed } from '../../../src/shared/worktree/github-pr-suppression'
import {
  shouldApplyBranchMismatchedLinkedPRClear,
  shouldApplyDivergedLinkedPRClear,
  shouldClearBranchMismatchedLinkedOpenPR,
  shouldClearDivergedLinkedMergedPR
} from '../../../src/shared/github/linked-pr-staleness'
import type { MobileWorktreeSummary } from '../source-control/mobile-worktree-metadata-operations'
import type { WorktreeGitHubPRLink } from '../source-control/mobile-pr-link'
import { translate } from '../i18n/mobile-i18n'

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
  | { kind: 'ready'; data: PrSidebarData }
  | { kind: 'none' }
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
  ) => Promise<
    GitHubPrReadOutcome<import('../../../src/shared/hosted-review').HostedReviewInfo | null>
  >
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
    }
  ) => Promise<GitHubPrReadOutcome<PRInfo | null>>
  fetchWorkItemDetails: (
    worktreeId: string,
    args: { prNumber: number }
  ) => Promise<GitHubPrReadOutcome<GitHubWorkItemDetails | null>>
  fetchPRChecks: (
    worktreeId: string,
    args: { prNumber: number; headSha?: string | null; prRepo?: GitHubPrRepoSlug | null }
  ) => Promise<GitHubPrReadOutcome<PRCheckDetail[]>>
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

// Show PR/checks before heavy body/comments; parallel link resolution also retains closed/merged reviews.
export async function loadPrSidebarData(
  deps: PrSidebarLoadDeps,
  args: {
    worktreeId: string
    branch: string
    headSha?: string | null
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<PrSidebarState> {
  try {
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
        currentHeadOid: requestHeadOid
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
      return failureState(prOutcome.error)
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
    const pr = prOutcome.result
    const checksOutcome = await deps.fetchPRChecks(args.worktreeId, {
      prNumber: pr.number,
      // Creating a PR may first commit, making its fetched head fresher than cached git status.
      headSha: pr.headSha ?? args.headSha ?? null,
      // Fork checks must use the fetched PR’s repo identity.
      prRepo: pr.prRepo ?? args.prRepo ?? null
    })
    // A check failure must not hide title, comments or merge controls.
    if (!checksOutcome.ok) {
      return {
        kind: 'ready',
        data: {
          pr,
          details: null,
          checks: [],
          checksError: checksOutcome.error,
          pushTarget: link.pushTarget
        }
      }
    }
    return {
      kind: 'ready',
      data: {
        pr,
        details: null,
        checks: checksOutcome.result,
        checksError: null,
        pushTarget: link.pushTarget
      }
    }
  } catch (err) {
    // Rejected dependencies must settle as UI errors rather than unhandled rejections.
    return err instanceof Error
      ? failureState(err.message)
      : {
          kind: 'error',
          message: translate('session.prSidebarState.loadFailed', 'Unable to load pull request')
        }
  }
}

export async function loadPrSidebarDetails(
  deps: PrSidebarLoadDeps,
  worktreeId: string,
  prNumber: number
): Promise<GitHubWorkItemDetails | null> {
  try {
    const outcome = await deps.fetchWorkItemDetails(worktreeId, { prNumber })
    return outcome.ok ? outcome.result : null
  } catch {
    // Details failure leaves the PR usable without comments.
    return null
  }
}

// Null means loading; finish failed loads with prior details or a placeholder so spinners stop.
export function resolvePrSidebarDetailsAfterPhase2(args: {
  fetched: GitHubWorkItemDetails | null
  prior: GitHubWorkItemDetails | null
  pr: PRInfo
}): GitHubWorkItemDetails {
  if (args.fetched != null) {
    return args.fetched
  }
  if (args.prior != null) {
    return args.prior
  }
  return emptyPrSidebarDetails(args.pr)
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

// Head changes refresh visible/in-flight sidebar work only.
export function shouldSoftRefreshPrSidebarOnHeadChange(kind: PrSidebarState['kind']): boolean {
  return kind === 'ready' || kind === 'none' || kind === 'loading'
}

export function shouldApplyResult(resultSeq: number, latestSeq: number): boolean {
  return resultSeq === latestSeq
}
