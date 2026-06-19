import type { GitHubWorkItemDetails, PRCheckDetail, PRInfo } from '../../../src/shared/types'
import type { GitHubPrReadOutcome, GitHubPrRepoSlug } from './github-pr-rpc'
import { resolveLinkedPrNumber } from './mobile-pr-sidebar-resolve'

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
  // The worktree's persisted linkedPR (fallback resolver for closed/merged PRs).
  // Fetched in parallel with forBranch to keep it off the critical path.
  fetchWorktreeLinkedPR: (worktreeId: string) => Promise<number | null>
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

// Phase 1: load the PR + checks fast and show the sidebar. The heavy comments/body
// payload (workItemDetails) is deferred to loadPrSidebarDetails so it never blocks the
// actionable PR UI — `data.details` starts null and is filled in by the second phase.
// forBranch + the worktree linkedPR read run in parallel (independent), then combine
// via resolveLinkedPrNumber so a closed/merged linked PR still resolves (KTD4).
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
    const [hintOutcome, linkedPR] = await Promise.all([
      deps.fetchForBranch(args.worktreeId, { branch: args.branch }),
      deps.fetchWorktreeLinkedPR(args.worktreeId)
    ])
    const branchHint =
      hintOutcome.ok && hintOutcome.result?.provider === 'github' ? hintOutcome.result.number : null
    const linkedPRNumber = resolveLinkedPrNumber(branchHint, linkedPR)

    const prOutcome = await deps.fetchPRForBranch(args.worktreeId, {
      branch: args.branch,
      linkedPRNumber
    })
    if (!prOutcome.ok) {
      return failureState(prOutcome.error)
    }
    if (!prOutcome.result) {
      // GitHub repo, but this branch has no open/linked PR — surfaced as an empty state.
      return { kind: 'none' }
    }
    const pr = prOutcome.result
    const checksOutcome = await deps.fetchPRChecks(args.worktreeId, {
      prNumber: pr.number,
      headSha: args.headSha ?? pr.headSha ?? null,
      // Prefer the fetched PR's own repo identity so fork PRs key their cached
      // checks correctly; fall back to an explicit override then null.
      prRepo: pr.prRepo ?? args.prRepo ?? null
    })
    if (!checksOutcome.ok) {
      return failureState(checksOutcome.error)
    }
    // details: null = comments still loading (phase 2). The header/reviewers degrade to
    // the PRInfo fields until it arrives.
    return { kind: 'ready', data: { pr, details: null, checks: checksOutcome.result } }
  } catch (err) {
    // Why: a dep that rejects (instead of returning `{ ok:false }`) must still
    // resolve to an error state, not escape as an unhandled rejection.
    return failureState(err instanceof Error ? err.message : 'Unable to load pull request')
  }
}

// Phase 2: fetch the work-item details (body + comments + participants). Non-fatal —
// a failure leaves the PR shown with an empty comments section rather than erroring out.
export async function loadPrSidebarDetails(
  deps: PrSidebarLoadDeps,
  worktreeId: string,
  prNumber: number
): Promise<GitHubWorkItemDetails | null> {
  try {
    const outcome = await deps.fetchWorkItemDetails(worktreeId, { prNumber })
    return outcome.ok ? outcome.result : null
  } catch {
    // Why: phase 2 is non-fatal — a rejection leaves the PR shown without comments
    // rather than escaping as an unhandled rejection.
    return null
  }
}

// Stale-response guard (KTD6): a load tagged with an older sequence must not
// overwrite a newer one. The hook bumps a monotonic counter per load.
export function shouldApplyResult(resultSeq: number, latestSeq: number): boolean {
  return resultSeq === latestSeq
}
