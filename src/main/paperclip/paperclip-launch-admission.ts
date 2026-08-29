export type PaperclipIssueClaimEvidence = {
  status: string | null
  checkoutRunId: string | null
  executionRunId: string | null
  executionLockedAt: string | null
}

export type PaperclipActiveRunObservation =
  | { state: 'present' }
  | { state: 'absent' }
  | {
      state: 'unknown'
      reason: 'unavailable' | 'unauthorized' | 'unsupported' | 'invalid' | 'stale'
    }

import type { PaperclipLaunchAdmission } from '../../shared/paperclip-types'

export function reducePaperclipActiveRunResponse(input: {
  body: unknown
  expectedIssueId: string
  expectedCompanyId: string
}): PaperclipActiveRunObservation {
  if (input.body === null) {
    return { state: 'absent' }
  }
  if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
    return { state: 'unknown', reason: 'invalid' }
  }
  const run = input.body as Record<string, unknown>
  if (
    typeof run.id !== 'string' ||
    run.id.trim().length === 0 ||
    run.issueId !== input.expectedIssueId ||
    (run.status !== 'queued' && run.status !== 'running') ||
    (run.companyId !== undefined && run.companyId !== input.expectedCompanyId)
  ) {
    return { state: 'unknown', reason: 'invalid' }
  }

  // Presence is the only retained fact. Session-derived fields must die here.
  return { state: 'present' }
}

export function decidePaperclipLaunchAdmission(input: {
  activeRun: PaperclipActiveRunObservation
  issue: PaperclipIssueClaimEvidence
}): PaperclipLaunchAdmission {
  if (input.activeRun.state === 'present') {
    return { allowed: false, reason: 'active_run' }
  }
  if (input.activeRun.state === 'unknown') {
    return { allowed: false, reason: 'unknown_run_state' }
  }
  if (
    input.issue.status === 'in_progress' ||
    hasValue(input.issue.checkoutRunId) ||
    hasValue(input.issue.executionRunId) ||
    hasValue(input.issue.executionLockedAt)
  ) {
    return { allowed: false, reason: 'claim_markers' }
  }
  return { allowed: true, requiresNonExclusiveConfirmation: true }
}

function hasValue(value: string | null): boolean {
  return typeof value === 'string' && value.trim().length > 0
}
