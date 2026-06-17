import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../../src/shared/types'
import {
  checkOutcome,
  getPRReviewerRows,
  prCheckKey,
  prStateBadge,
  sortPRChecks,
  summarizePRChecks
} from './pr-checks-presentation'

function check(over: Partial<PRCheckDetail>): PRCheckDetail {
  return {
    name: 'ci',
    status: 'completed',
    conclusion: 'success',
    url: null,
    ...over
  }
}

describe('checkOutcome', () => {
  it('treats a completed null-conclusion check as pending, not failure', () => {
    expect(checkOutcome(check({ status: 'completed', conclusion: null }))).toBe('pending')
  })
  it('treats queued/in_progress as pending', () => {
    expect(checkOutcome(check({ status: 'queued', conclusion: null }))).toBe('pending')
    expect(checkOutcome(check({ status: 'in_progress', conclusion: null }))).toBe('pending')
  })
  it('maps failure/cancelled/timed_out to failure', () => {
    expect(checkOutcome(check({ conclusion: 'failure' }))).toBe('failure')
    expect(checkOutcome(check({ conclusion: 'cancelled' }))).toBe('failure')
    expect(checkOutcome(check({ conclusion: 'timed_out' }))).toBe('failure')
  })
  it('maps neutral/skipped to neutral (non-blocking)', () => {
    expect(checkOutcome(check({ conclusion: 'neutral' }))).toBe('neutral')
    expect(checkOutcome(check({ conclusion: 'skipped' }))).toBe('neutral')
  })
})

describe('sortPRChecks', () => {
  it('orders failures first, then pending, then success', () => {
    const checks = [
      check({ name: 'ok', conclusion: 'success' }),
      check({ name: 'pending', status: 'in_progress', conclusion: null }),
      check({ name: 'broke', conclusion: 'failure' })
    ]
    expect(sortPRChecks(checks).map((c) => c.name)).toEqual(['broke', 'pending', 'ok'])
  })
  it('is stable within a bucket', () => {
    const checks = [
      check({ name: 'a', conclusion: 'failure' }),
      check({ name: 'b', conclusion: 'failure' })
    ]
    expect(sortPRChecks(checks).map((c) => c.name)).toEqual(['a', 'b'])
  })
})

describe('summarizePRChecks', () => {
  it('returns a "No checks" summary for an empty list', () => {
    const summary = summarizePRChecks([])
    expect(summary.total).toBe(0)
    expect(summary.outcome).toBe('none')
    expect(summary.label).toBe('No checks')
  })
  it('counts pass/pending/fail and reports worst-case outcome', () => {
    const summary = summarizePRChecks([
      check({ conclusion: 'success' }),
      check({ status: 'in_progress', conclusion: null }),
      check({ conclusion: 'failure' })
    ])
    expect(summary).toMatchObject({
      total: 3,
      passed: 1,
      pending: 1,
      failed: 1,
      outcome: 'failure'
    })
    expect(summary.label).toBe('1 failing · 1 pending · 1 passed')
  })
  it('reports pending when no failures but some pending', () => {
    expect(
      summarizePRChecks([
        check({ conclusion: 'success' }),
        check({ status: 'queued', conclusion: null })
      ]).outcome
    ).toBe('pending')
  })
  it('reports success when all pass', () => {
    expect(summarizePRChecks([check({ conclusion: 'success' })]).outcome).toBe('success')
  })
  it('reports a neutral-only set as neutral with a labeled count (not empty success)', () => {
    const summary = summarizePRChecks([
      check({ conclusion: 'neutral' }),
      check({ conclusion: 'skipped' })
    ])
    expect(summary).toMatchObject({
      total: 2,
      passed: 0,
      pending: 0,
      failed: 0,
      outcome: 'neutral'
    })
    expect(summary.label).toBe('2 neutral')
  })
})

describe('prCheckKey', () => {
  it('prefers checkRunId, then workflowRunId, then name', () => {
    expect(prCheckKey(check({ checkRunId: 5, workflowRunId: 9 }))).toBe('run:5')
    expect(prCheckKey(check({ workflowRunId: 9 }))).toBe('wf:9')
    expect(prCheckKey(check({ name: 'lint' }))).toBe('name:lint')
  })
})

describe('prStateBadge', () => {
  it('maps each PR state to a label + token', () => {
    expect(prStateBadge('open')).toEqual({ label: 'Open', token: 'textSecondary' })
    expect(prStateBadge('closed')).toEqual({ label: 'Closed', token: 'textSecondary' })
    expect(prStateBadge('merged')).toEqual({ label: 'Merged', token: 'textSecondary' })
    expect(prStateBadge('draft')).toEqual({ label: 'Draft', token: 'textSecondary' })
  })
})

describe('getPRReviewerRows', () => {
  it('returns empty for no reviewers', () => {
    expect(getPRReviewerRows({})).toEqual([])
  })
  it('labels requested-only reviewers as Requested', () => {
    const rows = getPRReviewerRows({
      reviewRequests: [{ login: 'alice', name: 'Alice', avatarUrl: 'a' }]
    })
    expect(rows).toEqual([
      {
        login: 'alice',
        name: 'Alice',
        avatarUrl: 'a',
        stateLabel: 'Requested',
        token: 'statusAmber'
      }
    ])
  })
  it('maps latest-review states to labels', () => {
    const rows = getPRReviewerRows({
      latestReviews: [
        { login: 'bob', state: 'APPROVED' },
        { login: 'carol', state: 'CHANGES_REQUESTED' }
      ]
    })
    expect(rows.map((r) => [r.login, r.stateLabel, r.token])).toEqual([
      ['bob', 'Approved', 'statusGreen'],
      ['carol', 'Changes requested', 'statusRed']
    ])
  })
  it('dedupes a reviewer present in both requests and reviews (requested wins)', () => {
    const rows = getPRReviewerRows({
      reviewRequests: [{ login: 'alice', name: null, avatarUrl: '' }],
      latestReviews: [{ login: 'alice', state: 'APPROVED' }]
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].stateLabel).toBe('Requested')
  })
})
