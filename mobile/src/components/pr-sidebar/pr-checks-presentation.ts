import type { PRCheckDetail, PRState, ProviderCheckSummary } from '../../../../src/shared/types'
import {
  classifyCheckOutcome,
  summarizeProviderChecks,
  type CheckOutcome as SharedCheckOutcome
} from '../../../../src/shared/provider-check-summary'
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

const OUTCOME_BY_SHARED: Record<SharedCheckOutcome, CheckOutcome> = {
  passed: 'success',
  failed: 'failure',
  pending: 'pending',
  neutral: 'neutral'
}

// Why: delegate to the one shared classifier — a second copy here is what made mobile call a
// `skipped` check unresolved and an `action_required` gate pending while desktop called them
// green and red for the same PR.
export function checkOutcome(check: PRCheckDetail): CheckOutcome {
  return OUTCOME_BY_SHARED[classifyCheckOutcome(check)]
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

const OUTCOME_BY_STATE: Record<ProviderCheckSummary['state'], CheckOutcome | 'none'> = {
  success: 'success',
  failure: 'failure',
  pending: 'pending',
  neutral: 'neutral',
  none: 'none'
}

export function summarizePRChecks(checks: readonly PRCheckDetail[]): PRChecksSummary {
  if (checks.length === 0) {
    return {
      total: 0,
      passed: 0,
      pending: 0,
      failed: 0,
      outcome: 'none',
      label: t('prChecksPresentation.no')
    }
  }
  // Counts and the worst-case rollup come from the shared summarizer; only the label wording is mobile's.
  const { total, passed, pending, failed, neutral, state } = summarizeProviderChecks(checks)
  const outcome = OUTCOME_BY_STATE[state]
  const parts: string[] = []
  if (failed > 0) {
    parts.push(
      t(failed === 1 ? 'prChecks.summary.failing.one' : 'prChecks.summary.failing.other', {
        count: failed
      })
    )
  }
  if (pending > 0) {
    parts.push(
      t(pending === 1 ? 'prChecks.summary.pending.one' : 'prChecks.summary.pending.other', {
        count: pending
      })
    )
  }
  if (passed > 0) {
    parts.push(
      t(passed === 1 ? 'prChecks.summary.passed.one' : 'prChecks.summary.passed.other', {
        count: passed
      })
    )
  }
  if (neutral > 0) {
    parts.push(
      t(neutral === 1 ? 'prChecks.summary.neutral.one' : 'prChecks.summary.neutral.other', {
        count: neutral
      })
    )
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

// Per-row status word shown beside each check (desktop ChecksList parity), so the
// outcome is readable without expanding the row. Mirrors getCheckStatusLabel.
export function checkStatusLabel(check: PRCheckDetail): string {
  if (check.status !== 'completed') {
    return check.status === 'in_progress'
      ? t('prChecksPresentation.progress')
      : t('prChecksPresentation.pending')
  }
  switch (check.conclusion) {
    case 'success':
      return t('prChecksPresentation.successful')
    case 'failure':
      return t('prChecksPresentation.failed')
    case 'cancelled':
      return t('prChecksPresentation.cancelled')
    case 'timed_out':
      return t('prChecksPresentation.timed')
    case 'action_required':
      return t('prChecks.status.actionRequired')
    case 'neutral':
      return t('prChecksPresentation.neutral')
    case 'skipped':
      return t('prChecksPresentation.skipped')
    default:
      return t('prChecksPresentation.pending')
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
  open: t('prChecksPresentation.open'),
  merged: t('prChecksPresentation.merged'),
  draft: t('prChecksPresentation.draft'),
  closed: t('prChecksPresentation.closed')
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
      return {
        label: t('prChecksPresentation.approved'),
        token: 'statusGreen'
      }
    case 'CHANGES_REQUESTED':
      return {
        label: t('prChecksPresentation.changes'),
        token: 'statusRed'
      }
    case 'COMMENTED':
      return {
        label: t('prChecksPresentation.commented'),
        token: 'textSecondary'
      }
    case 'DISMISSED':
      return {
        label: t('prChecksPresentation.dismissed'),
        token: 'textSecondary'
      }
    case 'PENDING':
      return {
        label: t('prChecksPresentation.pending'),
        token: 'statusAmber'
      }
    case null:
    case undefined:
      return {
        label: t('prChecksPresentation.reviewed'),
        token: 'textSecondary'
      }
    default:
      return {
        label: t('prChecksPresentation.reviewed'),
        token: 'textSecondary'
      }
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
      stateLabel: t('prChecksPresentation.requested'),
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
