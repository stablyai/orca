import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import type {
  PRState,
  ProviderCheckSummary
} from '../../../../src/shared/github/pull-request-types'
import {
  classifyCheckOutcome,
  summarizeProviderChecks,
  type CheckOutcome as SharedCheckOutcome
} from '../../../../src/shared/provider-check-summary'
import { prStateToken } from '../pr-state-token'

// Pure RN-free checks/badge logic follows desktop merge-state and reviewer presenters.

// Return theme token names; components resolve colors so pure logic stays style-free.
export type MobileStatusToken =
  | 'statusGreen'
  | 'statusAmber'
  | 'statusRed'
  | 'statusPurple'
  | 'textSecondary'

export type CheckOutcome = 'success' | 'pending' | 'failure' | 'neutral'

const OUTCOME_BY_SHARED: Record<SharedCheckOutcome, CheckOutcome> = {
  passed: 'success',
  failed: 'failure',
  pending: 'pending',
  neutral: 'neutral'
}

// Share desktop classifier: duplicate logic misclassified skipped as unresolved and action_required as pending.
export function checkOutcome(check: PRCheckDetail): CheckOutcome {
  return OUTCOME_BY_SHARED[classifyCheckOutcome(check)]
}

// Stable failure→pending→success/neutral buckets retain upstream order within each.
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
  outcome: CheckOutcome | 'none'
  label: string
}

const OUTCOME_BY_STATE: Record<ProviderCheckSummary['state'], CheckOutcome | 'none'> = {
  success: 'success',
  failure: 'failure',
  pending: 'pending',
  neutral: 'neutral',
  none: 'none'
}

export function summarizePRChecks(checks: readonly PRCheckDetail[]): PRChecksSummary {
  if (checks.length === 0) {
    return { total: 0, passed: 0, pending: 0, failed: 0, outcome: 'none', label: 'No checks' }
  }
  // Counts and the worst-case rollup come from the shared summarizer; only the label wording is mobile's.
  const { total, passed, pending, failed, neutral, state } = summarizeProviderChecks(checks)
  const outcome = OUTCOME_BY_STATE[state]
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
    total,
    passed,
    pending,
    failed,
    outcome,
    label: parts.join(' · ')
  }
}

/** An unreadable checks reply is not an absent one, so the header must not read "No checks". */
export function prChecksSummaryLabel(summary: PRChecksSummary, checksError: string | null): string {
  return checksError === null ? summary.label : 'Checks unavailable'
}

export function checkStatusLabel(check: PRCheckDetail): string {
  if (check.status !== 'completed') {
    return check.status === 'in_progress' ? 'In progress' : 'Pending'
  }
  switch (check.conclusion) {
    case 'success':
      return 'Successful'
    case 'failure':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'timed_out':
      return 'Timed out'
    case 'action_required':
      return 'Action required'
    case 'neutral':
      return 'Neutral'
    case 'skipped':
      return 'Skipped'
    default:
      return 'Pending'
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

// Cache detail by numeric run id, falling back to name (unique per head), so re-expansion avoids refetch.
export function prCheckKey(check: PRCheckDetail): string {
  if (typeof check.checkRunId === 'number') {
    return `run:${check.checkRunId}`
  }
  if (typeof check.workflowRunId === 'number') {
    return `wf:${check.workflowRunId}`
  }
  return `name:${check.name}`
}

// Use sorted list for first-failure auto-expand so chosen row matches rendered actionable order.
export function firstFailingCheckKey(checks: readonly PRCheckDetail[]): string | null {
  for (const check of checks) {
    if (checkOutcome(check) === 'failure') {
      return prCheckKey(check)
    }
  }
  return null
}

export type PRStateBadge = {
  label: string
  token: MobileStatusToken
}

const PR_STATE_LABELS: Record<PRState, string> = {
  open: 'Open',
  merged: 'Merged',
  draft: 'Draft',
  closed: 'Closed'
}

// Use shared prStateToken so sidebar and workspace badge agree on merged/open/closed/draft colors.
export function prStateBadge(state: PRState): PRStateBadge {
  return { label: PR_STATE_LABELS[state] ?? state, token: prStateToken(state) }
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

// Match desktop reviewer rows: requested first, then latest review authors, deduplicated by login.
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
