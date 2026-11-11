import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { readPacedPROutcome, recordPRLastOutcome, startPRLookup } from './pr-last-outcome'

const request = {
  linkedPRNumber: null,
  fallbackPRNumber: null,
  acceptMergedFallbackPR: false,
  currentHeadOid: 'head-a'
}

function found(overrides: Partial<PRInfo> = {}): PRRefreshOutcome {
  return {
    kind: 'found',
    fetchedAt: Date.now(),
    pr: {
      number: 7,
      title: 'PR',
      state: 'open',
      url: 'https://github.com/acme/repo/pull/7',
      checksStatus: 'pending',
      updatedAt: '2026-11-01T00:00:00Z',
      mergeable: 'MERGEABLE',
      headSha: 'head-a',
      ...overrides
    }
  }
}

function record(
  key: string,
  outcome: PRRefreshOutcome | null,
  headOid = 'head-a',
  acceptMergedFallbackPR = false
): void {
  recordPRLastOutcome(key, {
    start: startPRLookup(),
    linkedPRNumber: null,
    fallbackPRNumber: null,
    acceptMergedFallbackPR,
    headOid,
    outcome
  })
}

describe('readPacedPROutcome', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never reuses on the default cadence', () => {
    record('k-default', found())
    expect(readPacedPROutcome('k-default', request, 'default')).toBeNull()
  })

  it('reuses the last answer until the host’s stretched interval passes', () => {
    const outcome = found()
    record('k-reduced', outcome)
    vi.advanceTimersByTime(4 * 60_000)
    expect(readPacedPROutcome('k-reduced', request, 'reduced')).toBe(outcome)
    vi.advanceTimersByTime(60_000)
    expect(readPacedPROutcome('k-reduced', request, 'reduced')).toBeNull()
  })

  it('reuses a no-PR answer and keeps reusing any answer when off', () => {
    const none: PRRefreshOutcome = { kind: 'no-pr', fetchedAt: Date.now() }
    record('k-off', none)
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(readPacedPROutcome('k-off', request, 'off')).toBe(none)
  })

  it('asks GitHub again after a new commit, an error, or a narrowed read', () => {
    record('k-head', found(), 'head-old')
    expect(readPacedPROutcome('k-head', request, 'off')).toBeNull()

    record('k-error', {
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'boom',
      fetchedAt: Date.now()
    })
    expect(readPacedPROutcome('k-error', request, 'off')).toBeNull()

    record('k-narrowed', null)
    expect(readPacedPROutcome('k-narrowed', request, 'off')).toBeNull()
  })

  it('asks GitHub again when the request accepts a merged fallback the last one rejected', () => {
    // No request HEAD, branch gone, fallback #7 merged: false resolves to no-pr, true to found.
    const rejected: PRRefreshOutcome = { kind: 'no-pr', fetchedAt: Date.now() }
    record('k-accept', rejected, 'head-a', false)
    expect(
      readPacedPROutcome('k-accept', { ...request, acceptMergedFallbackPR: true }, 'off')
    ).toBeNull()
    expect(readPacedPROutcome('k-accept', request, 'off')).toBe(rejected)
  })

  it('asks GitHub again when the request names another PR', () => {
    record('k-linked', found())
    expect(readPacedPROutcome('k-linked', { ...request, linkedPRNumber: 9 }, 'off')).toBeNull()
  })

  it('keeps answers older than the phone window for a slower cadence', () => {
    const outcome = found()
    record('k-old', outcome)
    vi.advanceTimersByTime(60_000)
    // A later insert used to evict every entry older than 30 s.
    record('k-other', found())
    expect(readPacedPROutcome('k-old', request, 'minimal')).toBe(outcome)
  })
})
