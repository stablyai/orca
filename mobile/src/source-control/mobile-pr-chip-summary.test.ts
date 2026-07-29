import { describe, it, expect } from 'vitest'
import type { PRCheckDetail, PRComment, PRInfo } from '../../../src/shared/types'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import { buildMobilePrChipSummary, countUnresolvedReviewThreads } from './mobile-pr-chip-summary'

function pr(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 7701,
    title: 'Make center split more visible',
    state: 'open',
    url: 'https://example.test/pr/7701',
    checksStatus: 'success',
    updatedAt: '2026-07-07T00:00:00Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function check(
  conclusion: PRCheckDetail['conclusion'],
  status: PRCheckDetail['status'] = 'completed'
): PRCheckDetail {
  return { name: `check-${conclusion}-${status}`, status, conclusion, url: null }
}

function ready(prInfo: PRInfo, checks: PRCheckDetail[]): PrSidebarState {
  return { kind: 'ready', data: { pr: prInfo, checks, details: null } }
}

describe('buildMobilePrChipSummary', () => {
  it('maps non-ready states', () => {
    expect(buildMobilePrChipSummary({ kind: 'hidden' })).toEqual({ kind: 'loading' })
    expect(buildMobilePrChipSummary({ kind: 'loading' })).toEqual({ kind: 'loading' })
    expect(buildMobilePrChipSummary({ kind: 'none' })).toEqual({ kind: 'none' })
    expect(buildMobilePrChipSummary({ kind: 'error', message: 'net' })).toEqual({
      kind: 'unavailable',
      message: 'net'
    })
    expect(buildMobilePrChipSummary({ kind: 'blocked', message: 'auth' })).toEqual({
      kind: 'unavailable',
      message: 'auth'
    })
  })

  it('surfaces the PR number and state badge', () => {
    const summary = buildMobilePrChipSummary(ready(pr({ state: 'draft' }), [check('success')]))
    expect(summary.kind).toBe('ready')
    if (summary.kind !== 'ready') {
      return
    }
    expect(summary.number).toBe(7701)
    expect(summary.stateLabel).toBe('Draft')
  })

  it('rolls up passed checks as passed/total', () => {
    const summary = buildMobilePrChipSummary(
      ready(pr(), [check('success'), check('success'), check('skipped')])
    )
    if (summary.kind !== 'ready') {
      throw new Error('expected ready')
    }
    expect(summary.rollup).toEqual({ kind: 'passed', text: '2/3', token: 'statusGreen' })
  })

  it('prefers failing over running and passing', () => {
    const summary = buildMobilePrChipSummary(
      ready(pr(), [check('success'), check('failure'), check(null, 'in_progress')])
    )
    if (summary.kind !== 'ready') {
      throw new Error('expected ready')
    }
    expect(summary.rollup).toEqual({ kind: 'failing', text: '1 failing', token: 'statusRed' })
  })

  it('shows running when nothing has failed yet', () => {
    const summary = buildMobilePrChipSummary(ready(pr(), [check('success'), check(null, 'queued')]))
    if (summary.kind !== 'ready') {
      throw new Error('expected ready')
    }
    expect(summary.rollup).toEqual({ kind: 'running', text: '1 running', token: 'statusAmber' })
  })

  it('lets a merge conflict win over green checks', () => {
    const summary = buildMobilePrChipSummary(
      ready(pr({ mergeable: 'CONFLICTING' }), [check('success')])
    )
    if (summary.kind !== 'ready') {
      throw new Error('expected ready')
    }
    expect(summary.rollup.kind).toBe('conflict')
  })

  it('reports no checks when the list is empty', () => {
    const summary = buildMobilePrChipSummary(ready(pr(), []))
    if (summary.kind !== 'ready') {
      throw new Error('expected ready')
    }
    expect(summary.rollup).toEqual({ kind: 'none', text: 'No checks', token: 'textSecondary' })
  })

  it('passes through the unresolved comment count', () => {
    const summary = buildMobilePrChipSummary(ready(pr(), [check('success')]), 3)
    if (summary.kind !== 'ready') {
      throw new Error('expected ready')
    }
    expect(summary.commentCount).toBe(3)
  })
})

describe('countUnresolvedReviewThreads', () => {
  function comment(overrides: Partial<PRComment>): PRComment {
    return {
      id: 1,
      author: 'octocat',
      authorAvatarUrl: '',
      body: 'x',
      createdAt: '2026-07-07T00:00:00Z',
      url: '',
      ...overrides
    }
  }

  it('returns null when details have not loaded', () => {
    expect(countUnresolvedReviewThreads(null)).toBeNull()
    expect(countUnresolvedReviewThreads(undefined)).toBeNull()
  })

  it('counts each unresolved thread once and ignores resolved threads', () => {
    const comments = [
      comment({ id: 1, threadId: 't1', isResolved: false }),
      comment({ id: 2, threadId: 't1', isResolved: false }),
      comment({ id: 3, threadId: 't2', isResolved: true }),
      comment({ id: 4, threadId: 't3' }),
      comment({ id: 5 })
    ]
    expect(countUnresolvedReviewThreads(comments)).toBe(2)
  })
})
