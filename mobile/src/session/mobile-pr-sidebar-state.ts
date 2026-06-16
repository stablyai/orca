import type { GitHubWorkItemDetails, PRCheckDetail, PRInfo } from '../../../src/shared/types'
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
  // The branch has no open PR — distinct from `hidden` so the opened sidebar can
  // explain it (the dedicated icon is always available on a GitHub repo).
  | { kind: 'none' }
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

// Loads the authoritative PR + checks when the user opens the sidebar. The host's
// forBranch (provider-agnostic) supplies a linked-PR hint that is threaded into
// github.prForBranch as the authoritative resolver (KTD4). A failed forBranch is
// non-fatal — prForBranch is still consulted and surfaces its own error.
export async function loadPrSidebarData(
  deps: PrSidebarLoadDeps,
  args: {
    worktreeId: string
    branch: string
    headSha?: string | null
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<PrSidebarState> {
  const hintOutcome = await deps.fetchForBranch(args.worktreeId, { branch: args.branch })
  const linkedPRNumber = hintOutcome.ok && hintOutcome.result ? hintOutcome.result.number : null

  const prOutcome = await deps.fetchPRForBranch(args.worktreeId, {
    branch: args.branch,
    linkedPRNumber
  })
  if (!prOutcome.ok) {
    return failureState(prOutcome.error)
  }
  if (!prOutcome.result) {
    // GitHub repo, but this branch has no open PR — surfaced as an empty state.
    return { kind: 'none' }
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
