import type { PRCheckDetail, PRState } from '../../../../src/shared/types'

// Pure presentation logic for the PR sidebar's checks + state badge. No React /
// native imports so it is unit-testable under the node Vitest config (KTD5).
// Ports the LOGIC of the desktop presenters (github-pr-merge-state.ts,
// github-pr-reviewer-display.ts), not their components.

// The mobile-theme color tokens this logic maps to. Section components resolve
// the token name to an actual color from `mobile-theme`, keeping this module
// free of style imports.
export type MobileStatusToken = 'statusGreen' | 'statusAmber' | 'statusRed' | 'textSecondary'

export type CheckOutcome = 'success' | 'pending' | 'failure' | 'neutral'

const FAILURE_CONCLUSIONS = new Set<PRCheckDetail['conclusion']>([
  'failure',
  'cancelled',
  'timed_out'
])

const SUCCESS_CONCLUSIONS = new Set<PRCheckDetail['conclusion']>(['success'])

// Why: a check that is queued/in_progress, or completed with a null/`pending`
// conclusion, is still pending — never render it as a failure (U5 edge case).
export function checkOutcome(check: PRCheckDetail): CheckOutcome {
  if (check.status !== 'completed') {
    return 'pending'
  }
  if (check.conclusion === null || check.conclusion === 'pending') {
    return 'pending'
  }
  if (FAILURE_CONCLUSIONS.has(check.conclusion)) {
    return 'failure'
  }
  if (SUCCESS_CONCLUSIONS.has(check.conclusion)) {
    return 'success'
  }
  // neutral / skipped are non-blocking — treat as neutral, not failure.
  return 'neutral'
}

// Sort order: failures first (most actionable), then pending, then success /
// neutral. Stable within a bucket so the upstream ordering is preserved.
const OUTCOME_RANK: Record<CheckOutcome, number> = {
  failure: 0,
  pending: 1,
  neutral: 2,
  success: 3
}

export function sortPRChecks(checks: readonly PRCheckDetail[]): PRCheckDetail[] {
  return checks
    .map((check, index) => ({ check, index, rank: OUTCOME_RANK[checkOutcome(check)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.check)
}

export type PRChecksSummary = {
  total: number
  passed: number
  pending: number
  failed: number
  // Worst-case outcome across all checks, for the summary badge color.
  outcome: CheckOutcome | 'none'
  label: string
}

export function summarizePRChecks(checks: readonly PRCheckDetail[]): PRChecksSummary {
  if (checks.length === 0) {
    return { total: 0, passed: 0, pending: 0, failed: 0, outcome: 'none', label: 'No checks' }
  }
  let passed = 0
  let pending = 0
  let failed = 0
  let neutral = 0
  for (const check of checks) {
    const outcome = checkOutcome(check)
    if (outcome === 'failure') {
      failed += 1
    } else if (outcome === 'pending') {
      pending += 1
    } else if (outcome === 'success') {
      passed += 1
    } else {
      neutral += 1
    }
  }
  // Worst-case wins so a single failure colors the summary red even if others passed.
  // A neutral-only set reads as neutral (not success) with a non-empty label.
  const outcome: CheckOutcome | 'none' =
    failed > 0
      ? 'failure'
      : pending > 0
        ? 'pending'
        : passed > 0
          ? 'success'
          : neutral > 0
            ? 'neutral'
            : 'none'
  const parts: string[] = []
  if (failed > 0) {
    parts.push(`${failed} failing`)
  }
  if (pending > 0) {
    parts.push(`${pending} pending`)
  }
  if (passed > 0) {
    parts.push(`${passed} passed`)
  }
  if (neutral > 0) {
    parts.push(`${neutral} neutral`)
  }
  return {
    total: checks.length,
    passed,
    pending,
    failed,
    outcome,
    label: parts.join(' · ')
  }
}

export function checkOutcomeToken(outcome: CheckOutcome | 'none'): MobileStatusToken {
  switch (outcome) {
    case 'success':
      return 'statusGreen'
    case 'pending':
      return 'statusAmber'
    case 'failure':
      return 'statusRed'
    default:
      return 'textSecondary'
  }
}

// Stable identity for a check so its lazily-fetched detail can be cached and
// re-expanded without a second fetch (U5). Prefer the numeric run ids; fall
// back to the name (GitHub keeps check names unique per head commit).
export function prCheckKey(check: PRCheckDetail): string {
  if (typeof check.checkRunId === 'number') {
    return `run:${check.checkRunId}`
  }
  if (typeof check.workflowRunId === 'number') {
    return `wf:${check.workflowRunId}`
  }
  return `name:${check.name}`
}

export type PRStateBadge = {
  label: string
  token: MobileStatusToken
}

// State-badge mapping mirrors desktop merge-state presentation tones: merged is
// neutral, open is green (active), draft is muted, closed is red.
export function prStateBadge(state: PRState): PRStateBadge {
  // Why: the state badge is a neutral monochrome chip (the label carries the
  // state) so the sidebar stays muted/black-and-white per the design direction.
  switch (state) {
    case 'open':
      return { label: 'Open', token: 'textSecondary' }
    case 'merged':
      return { label: 'Merged', token: 'textSecondary' }
    case 'draft':
      return { label: 'Draft', token: 'textSecondary' }
    case 'closed':
      return { label: 'Closed', token: 'textSecondary' }
    default:
      return { label: state, token: 'textSecondary' }
  }
}

export type ReviewerRow = {
  login: string
  name: string | null
  avatarUrl: string
  stateLabel: string
  token: MobileStatusToken
}

function reviewStateLabel(state: string | null | undefined): {
  label: string
  token: MobileStatusToken
} {
  switch (state) {
    case 'APPROVED':
      return { label: 'Approved', token: 'statusGreen' }
    case 'CHANGES_REQUESTED':
      return { label: 'Changes requested', token: 'statusRed' }
    case 'COMMENTED':
      return { label: 'Commented', token: 'textSecondary' }
    case 'DISMISSED':
      return { label: 'Dismissed', token: 'textSecondary' }
    case 'PENDING':
      return { label: 'Pending', token: 'statusAmber' }
    case null:
    case undefined:
      return { label: 'Reviewed', token: 'textSecondary' }
    default:
      return { label: 'Reviewed', token: 'textSecondary' }
  }
}

type ReviewDisplayItem = {
  reviewRequests?: { login: string; name: string | null; avatarUrl: string }[]
  latestReviews?: { login: string; state?: string | null; avatarUrl?: string | null }[]
}

// Port of getGitHubPRReviewerRows: requested reviewers (status "Requested")
// followed by any latest-review authors not already requested, deduped by login.
export function getPRReviewerRows(item: ReviewDisplayItem): ReviewerRow[] {
  const byLogin = new Map<string, ReviewerRow>()
  for (const user of item.reviewRequests ?? []) {
    const login = user.login.trim()
    if (!login) {
      continue
    }
    byLogin.set(login.toLowerCase(), {
      login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      stateLabel: 'Requested',
      token: 'statusAmber'
    })
  }
  for (const review of item.latestReviews ?? []) {
    const login = review.login.trim()
    const key = login.toLowerCase()
    if (!login || byLogin.has(key)) {
      continue
    }
    const { label, token } = reviewStateLabel(review.state)
    byLogin.set(key, {
      login,
      name: null,
      avatarUrl: review.avatarUrl ?? '',
      stateLabel: label,
      token
    })
  }
  return Array.from(byLogin.values())
}
