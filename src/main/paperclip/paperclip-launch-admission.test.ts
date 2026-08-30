import { describe, expect, it } from 'vitest'
import {
  decidePaperclipLaunchAdmission,
  reducePaperclipActiveRunResponse,
  type PaperclipActiveRunObservation,
  type PaperclipIssueClaimEvidence
} from './paperclip-launch-admission'

const unclaimedIssue: PaperclipIssueClaimEvidence = {
  status: 'todo',
  checkoutRunId: null,
  executionRunId: null,
  executionLockedAt: null
}

describe('Paperclip active-run presence reduction', () => {
  it('retains only presence and drops session-derived canary content', () => {
    const observation = reducePaperclipActiveRunResponse({
      expectedIssueId: 'issue-1',
      expectedCompanyId: 'company-1',
      body: {
        id: 'run-1',
        issueId: 'issue-1',
        companyId: 'company-1',
        status: 'running',
        currentStatusMessage: 'CANARY_STATUS_TEXT',
        lastAssistantSnippet: 'CANARY_ASSISTANT_TEXT',
        currentToolName: 'CANARY_TOOL',
        outputSilence: { excerpt: 'CANARY_OUTPUT' }
      }
    })

    expect(observation).toEqual({ state: 'present' })
    expect(JSON.stringify(observation)).not.toContain('CANARY')
    expect(JSON.stringify(observation)).not.toContain('run-1')
  })

  it('accepts null as an authoritative absence', () => {
    expect(
      reducePaperclipActiveRunResponse({
        expectedIssueId: 'issue-1',
        expectedCompanyId: 'company-1',
        body: null
      })
    ).toEqual({ state: 'absent' })
  })

  it('fails closed for mismatched or malformed run objects', () => {
    for (const body of [
      { id: 'run-1', issueId: 'issue-2', status: 'running' },
      { id: 'run-1', issueId: 'issue-1', companyId: 'company-2', status: 'running' },
      { id: 'run-1', issueId: 'issue-1', status: 'finished' },
      { issueId: 'issue-1', status: 'running' },
      'running'
    ]) {
      expect(
        reducePaperclipActiveRunResponse({
          expectedIssueId: 'issue-1',
          expectedCompanyId: 'company-1',
          body
        })
      ).toEqual({ state: 'unknown', reason: 'invalid' })
    }
  })
})

describe('Paperclip launch admission', () => {
  it('blocks an active run and every unknown active-run state', () => {
    expect(
      decidePaperclipLaunchAdmission({ activeRun: { state: 'present' }, issue: unclaimedIssue })
    ).toEqual({ allowed: false, reason: 'active_run' })

    for (const reason of [
      'unavailable',
      'unauthorized',
      'unsupported',
      'invalid',
      'stale'
    ] as const) {
      const activeRun: PaperclipActiveRunObservation = { state: 'unknown', reason }
      expect(decidePaperclipLaunchAdmission({ activeRun, issue: unclaimedIssue })).toEqual({
        allowed: false,
        reason: 'unknown_run_state'
      })
    }
  })

  it.each([
    { status: 'in_progress' },
    { checkoutRunId: 'checkout-1' },
    { executionRunId: 'execution-1' },
    { executionLockedAt: '2026-08-29T12:00:00.000Z' }
  ])('blocks null active-run with remaining claim evidence: %o', (claim) => {
    expect(
      decidePaperclipLaunchAdmission({
        activeRun: { state: 'absent' },
        issue: { ...unclaimedIssue, ...claim }
      })
    ).toEqual({ allowed: false, reason: 'claim_markers' })
  })

  it('permits only explicit non-exclusive confirmation when no claim evidence exists', () => {
    expect(
      decidePaperclipLaunchAdmission({ activeRun: { state: 'absent' }, issue: unclaimedIssue })
    ).toEqual({ allowed: true, requiresNonExclusiveConfirmation: true })
  })
})
