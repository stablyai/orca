import { afterEach, describe, expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../../src/shared/types'
import { mobileI18n } from '../../i18n/mobile-i18n'
import {
  checkOutcome,
  checkStatusLabel,
  firstFailingCheckKey,
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

const INITIAL_LOCALE = mobileI18n.language

afterEach(async () => {
  await mobileI18n.changeLanguage(INITIAL_LOCALE)
})

describe('checkOutcome', () => {
  it('treats a completed null-conclusion check as neutral, not failure', () => {
    expect(checkOutcome(check({ status: 'completed', conclusion: null }))).toBe('neutral')
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
  it('maps a merge-blocking action_required gate to failure', () => {
    expect(checkOutcome(check({ conclusion: 'action_required' }))).toBe('failure')
  })
  it('maps skipped to success and neutral to neutral (desktop parity)', () => {
    expect(checkOutcome(check({ conclusion: 'skipped' }))).toBe('success')
    expect(checkOutcome(check({ conclusion: 'neutral' }))).toBe('neutral')
  })
})

describe('checkStatusLabel', () => {
  it('keeps the shared action-required conclusion in the mobile catalog', () => {
    expect(checkStatusLabel(check({ conclusion: 'action_required' }))).toBe('Action required')
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

describe('firstFailingCheckKey', () => {
  it('returns the key of the first failing check in the given order', () => {
    const checks = sortPRChecks([
      check({ name: 'ok', checkRunId: 1, conclusion: 'success' }),
      check({ name: 'broke', checkRunId: 2, conclusion: 'failure' }),
      check({ name: 'also-broke', checkRunId: 3, conclusion: 'cancelled' })
    ])
    expect(firstFailingCheckKey(checks)).toBe(prCheckKey(check({ checkRunId: 2 })))
  })
  it('returns null when nothing is failing', () => {
    expect(
      firstFailingCheckKey([
        check({ conclusion: 'success' }),
        check({ status: 'in_progress', conclusion: null })
      ])
    ).toBeNull()
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
      check({ conclusion: 'neutral' })
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
  it('counts skipped as passed so the sidebar matches desktop and the tasks grid', () => {
    const summary = summarizePRChecks([
      check({ conclusion: 'success' }),
      check({ conclusion: 'success' }),
      check({ conclusion: 'skipped' })
    ])
    expect(summary).toMatchObject({ total: 3, passed: 3, outcome: 'success' })
    expect(summary.label).toBe('3 passed')
  })
  it('uses localized plural-aware check summary fragments', async () => {
    await mobileI18n.changeLanguage('es')

    const summary = summarizePRChecks([
      check({ conclusion: 'success' }),
      check({ conclusion: 'success' }),
      check({ status: 'in_progress', conclusion: null }),
      check({ conclusion: 'failure' })
    ])

    expect(summary.label).toBe('1 con errores · 1 pendiente · 2 aprobadas')
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
  it('maps each PR state to a label + status-color token matching the workspace-list badge', () => {
    expect(prStateBadge('open')).toEqual({ label: 'Open', token: 'statusGreen' })
    expect(prStateBadge('closed')).toEqual({ label: 'Closed', token: 'statusRed' })
    expect(prStateBadge('merged')).toEqual({ label: 'Merged', token: 'statusPurple' })
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
