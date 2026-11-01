import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import {
  firstFailingCheckKey,
  prCheckKey,
  prChecksSummaryLabel,
  prStateBadge,
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

describe('firstFailingCheckKey', () => {
  it('returns the key of the first failing check in the given order', () => {
    const checks = [
      check({ name: 'ok', checkRunId: 1, conclusion: 'success' }),
      check({ name: 'broke', checkRunId: 2, conclusion: 'failure' }),
      check({ name: 'also-broke', checkRunId: 3, conclusion: 'cancelled' })
    ]
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
  it('reads the empty header as unavailable, not absent, when the checks read failed', () => {
    const summary = summarizePRChecks([])
    expect(prChecksSummaryLabel(summary, null)).toBe('No checks')
    expect(prChecksSummaryLabel(summary, 'The host sent a reply this app could not read')).toBe(
      'Checks unavailable'
    )
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
