import type { PRCheckDetail, PRState } from '../../../../src/shared/types'
import { prStateToken } from '../pr-state-token'
import { t } from '@/i18n/mobile-i18n'

// Pure presentation logic for the PR sidebar's checks + state badge. No React /
// native imports so it is unit-testable under the node Vitest config (KTD5).
// Ports the LOGIC of the desktop presenters (github-pr-merge-state.ts,
// github-pr-reviewer-display.ts), not their components.

// The mobile-theme color tokens this logic maps to. Section components resolve
// the token name to an actual color from `mobile-theme`, keeping this module
// free of style imports.
export type MobileStatusToken =
  | 'statusGreen'
  | 'statusAmber'
  | 'statusRed'
  | 'statusPurple'
  | 'textSecondary'

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
    return { total: 0, passed: 0, pending: 0, failed: 0, outcome: 'none', label: t('m.hCKjn9A') }
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

// Per-row status word shown beside each check (desktop ChecksList parity), so the
// outcome is readable without expanding the row. Mirrors getCheckStatusLabel.
export function checkStatusLabel(check: PRCheckDetail): string {
  if (check.status !== 'completed') {
    return check.status === 'in_progress' ? t('m.9XDJxdU') : t('m.NEg29tM')
  }
  switch (check.conclusion) {
    case 'success':
      return t('m.6lXfNVk')
    case 'failure':
      return t('m.NO0ZjtQ')
    case 'cancelled':
      return t('m.thrHxG4')
    case 'timed_out':
      return t('m.lyHptRM')
    case 'neutral':
      return t('m.Ba1jOdE')
    case 'skipped':
      return t('m.8I2nZuQ')
    default:
      return t('m.NEg29tM')
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

// Key of the first failing check in a list, or null when none fail. Mirrors the
// desktop ChecksList behavior of auto-expanding the first failed check on load.
// Pass the sorted list so "first" matches the rendered order (failures lead).
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
  open: t('m.sbQ_yBw'),
  merged: t('m.AF7gJFU'),
  draft: t('m.QYCFjQw'),
  closed: t('m.tNw1xEA')
}

// State-badge color comes from the shared prStateToken so the sidebar badge and
// the workspace-list linked-PR badge resolve the SAME color per state (merged =
// purple, open = green, closed = red, draft/unknown = muted).
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
      return { label: t('m.IloG18k'), token: 'statusGreen' }
    case 'CHANGES_REQUESTED':
      return { label: t('m.rjj84-Y'), token: 'statusRed' }
    case 'COMMENTED':
      return { label: t('m.bF0aphw'), token: 'textSecondary' }
    case 'DISMISSED':
      return { label: t('m.dmAcep8'), token: 'textSecondary' }
    case 'PENDING':
      return { label: t('m.NEg29tM'), token: 'statusAmber' }
    case null:
    case undefined:
      return { label: t('m._IeDTL8'), token: 'textSecondary' }
    default:
      return { label: t('m._IeDTL8'), token: 'textSecondary' }
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
      stateLabel: t('m.RfH2kOg'),
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
