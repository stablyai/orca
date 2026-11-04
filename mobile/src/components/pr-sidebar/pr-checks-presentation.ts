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
import { translate } from '../../i18n/mobile-i18n'

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
    return {
      total: 0,
      passed: 0,
      pending: 0,
      failed: 0,
      outcome: 'none',
      label: translate('pullRequest.prChecksPresentation.noChecks', 'No checks')
    }
  }
  // Counts and the worst-case rollup come from the shared summarizer; only the label wording is mobile's.
  const { total, passed, pending, failed, neutral, state } = summarizeProviderChecks(checks)
  const outcome = OUTCOME_BY_STATE[state]
  const parts: string[] = []
  if (failed > 0) {
    const count = failed
    parts.push(
      count === 1
        ? translate('pullRequest.prChecksPresentation.failing_one', '{{count}} failing', { count })
        : translate('pullRequest.prChecksPresentation.failing_other', '{{count}} failing', {
            count
          })
    )
  }
  if (pending > 0) {
    const count = pending
    parts.push(
      count === 1
        ? translate('pullRequest.prChecksPresentation.pending_one', '{{count}} pending', { count })
        : translate('pullRequest.prChecksPresentation.pending_other', '{{count}} pending', {
            count
          })
    )
  }
  if (passed > 0) {
    const count = passed
    parts.push(
      count === 1
        ? translate('pullRequest.prChecksPresentation.passed_one', '{{count}} passed', { count })
        : translate('pullRequest.prChecksPresentation.passed_other', '{{count}} passed', { count })
    )
  }
  if (neutral > 0) {
    const count = neutral
    parts.push(
      count === 1
        ? translate('pullRequest.prChecksPresentation.neutral_one', '{{count}} neutral', { count })
        : translate('pullRequest.prChecksPresentation.neutral_other', '{{count}} neutral', {
            count
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

/** An unreadable checks reply is not an absent one, so the header must not read "No checks". */
export function prChecksSummaryLabel(summary: PRChecksSummary, checksError: string | null): string {
  return checksError === null
    ? summary.label
    : translate('pullRequest.prChecksPresentation.unavailable', 'Checks unavailable')
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

function prStateLabels(): Record<PRState, string> {
  return {
    open: translate('pullRequest.prChecksPresentation.stateOpen', 'Open'),
    merged: translate('pullRequest.prChecksPresentation.stateMerged', 'Merged'),
    draft: translate('pullRequest.prChecksPresentation.stateDraft', 'Draft'),
    closed: translate('pullRequest.prChecksPresentation.stateClosed', 'Closed')
  }
}

// Use shared prStateToken so sidebar and workspace badge agree on merged/open/closed/draft colors.
export function prStateBadge(state: PRState): PRStateBadge {
  return { label: prStateLabels()[state] ?? state, token: prStateToken(state) }
}
