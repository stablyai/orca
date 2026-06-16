import type { GitHubWorkItemDetails, PRCheckDetail, PRInfo } from '../../../src/shared/types'
import type { HostedReviewProvider } from '../../../src/shared/hosted-review'
import type { GitHubPrReadOutcome, GitHubPrRepoSlug } from './github-pr-rpc'

// Pure state machine for the mobile PR sidebar. Kept free of React/native imports
// so the transitions are unit-testable under the node Vitest config (KTD5).

export type PrSidebarData = {
  pr: PRInfo
  details: GitHubWorkItemDetails | null
  checks: PRCheckDetail[]
}

// `blocked` is a permanent failure (no GitHub account / permission denied) that the
// user cannot retry away; `error` is transient (network/timeout). Keeping them
// distinct (R9/KTD7) stops a permission denial from looping through revert+retry.
export type PrSidebarState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: PrSidebarData }
  | { kind: 'error'; message: string }
  | { kind: 'blocked'; message: string }

export type PrSidebarEligibility =
  | { kind: 'hidden' }
  | { kind: 'eligible'; provider: HostedReviewProvider; prNumber: number }
  | { kind: 'error'; message: string }
  | { kind: 'blocked'; message: string }

// Why: host mutations/reads return permission and network failures in the same
// `{ ok:false, error:string }` shape; classify by message so a permanent failure
// routes to `blocked` instead of an endlessly-retryable `error`.
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
  fetchPRForBranch: (
    worktreeId: string,
    args: { branch: string; linkedPRNumber?: number | null }
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

// Resolves whether the sidebar trigger should appear: GitHub provider + a linked PR.
// Non-GitHub providers and branches with no PR resolve to `hidden` (KTD4/R8).
export async function resolvePrSidebarEligibility(
  deps: Pick<PrSidebarLoadDeps, 'fetchForBranch'>,
  args: { worktreeId: string; branch: string }
): Promise<PrSidebarEligibility> {
  const outcome = await deps.fetchForBranch(args.worktreeId, { branch: args.branch })
  if (!outcome.ok) {
    return failureState(outcome.error)
  }
  const info = outcome.result
  if (!info || info.provider !== 'github') {
    return { kind: 'hidden' }
  }
  return { kind: 'eligible', provider: info.provider, prNumber: info.number }
}

// Loads the authoritative PR + checks once the user opens the sidebar. The linked
// PR number from eligibility is threaded into github.prForBranch as the hint, then
// prForBranch's result is authoritative (KTD4).
export async function loadPrSidebarData(
  deps: Omit<PrSidebarLoadDeps, 'fetchForBranch'>,
  args: {
    worktreeId: string
    branch: string
    headSha?: string | null
    linkedPRNumber: number
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<PrSidebarState> {
  const prOutcome = await deps.fetchPRForBranch(args.worktreeId, {
    branch: args.branch,
    linkedPRNumber: args.linkedPRNumber
  })
  if (!prOutcome.ok) {
    return failureState(prOutcome.error)
  }
  if (!prOutcome.result) {
    return { kind: 'hidden' }
  }
  const pr = prOutcome.result
  const [detailsOutcome, checksOutcome] = await Promise.all([
    deps.fetchWorkItemDetails(args.worktreeId, { prNumber: pr.number }),
    deps.fetchPRChecks(args.worktreeId, {
      prNumber: pr.number,
      headSha: args.headSha ?? pr.headSha ?? null,
      // Prefer the fetched PR's own repo identity so fork PRs key their cached
      // checks correctly; fall back to an explicit override then null.
      prRepo: pr.prRepo ?? args.prRepo ?? null
    })
  ])
  if (!detailsOutcome.ok) {
    return failureState(detailsOutcome.error)
  }
  if (!checksOutcome.ok) {
    return failureState(checksOutcome.error)
  }
  return {
    kind: 'ready',
    data: { pr, details: detailsOutcome.result, checks: checksOutcome.result }
  }
}

// Stale-response guard (KTD6): a load tagged with an older sequence must not
// overwrite a newer one. The hook bumps a monotonic counter per load.
export function shouldApplyResult(resultSeq: number, latestSeq: number): boolean {
  return resultSeq === latestSeq
}
