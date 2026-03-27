import { describe, expect, it } from 'vitest'
import { deriveCheckStatus, mapPRState, mapCheckStatus, mapCheckConclusion } from './mappers'

describe('mapPRState', () => {
  it('returns draft when an open PR is marked as draft', () => {
    expect(mapPRState('OPEN', true)).toBe('draft')
  })

  it('preserves merged and closed states', () => {
    expect(mapPRState('MERGED', true)).toBe('merged')
    expect(mapPRState('CLOSED', true)).toBe('closed')
    expect(mapPRState('OPEN')).toBe('open')
  })

  it('handles lowercase inputs', () => {
    expect(mapPRState('merged')).toBe('merged')
    expect(mapPRState('closed')).toBe('closed')
    expect(mapPRState('open')).toBe('open')
  })

  it('returns open for undefined state', () => {
    expect(mapPRState(undefined as unknown as string)).toBe('open')
  })

  it('returns open for null state', () => {
    expect(mapPRState(null as unknown as string)).toBe('open')
  })

  it('returns open for unknown state', () => {
    expect(mapPRState('UNKNOWN')).toBe('open')
  })
})

describe('deriveCheckStatus', () => {
  it('returns neutral when no checks are present', () => {
    expect(deriveCheckStatus(null)).toBe('neutral')
    expect(deriveCheckStatus([])).toBe('neutral')
  })

  it('returns neutral for undefined input', () => {
    expect(deriveCheckStatus(undefined)).toBe('neutral')
  })

  it('returns failure when a failed check is present', () => {
    expect(deriveCheckStatus([{ status: 'QUEUED' }, { conclusion: 'FAILURE' }])).toBe('failure')
  })

  it('returns pending when checks are still running', () => {
    expect(deriveCheckStatus([{ status: 'IN_PROGRESS' }])).toBe('pending')
  })

  it('returns success when all checks complete without failures', () => {
    expect(deriveCheckStatus([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }])).toBe(
      'success'
    )
  })

  it('returns failure when mixed success and failure', () => {
    expect(deriveCheckStatus([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe(
      'failure'
    )
  })

  it('returns pending when mixed success and pending', () => {
    expect(deriveCheckStatus([{ conclusion: 'SUCCESS' }, { status: 'QUEUED' }])).toBe('pending')
  })

  it('returns success when all checks succeed', () => {
    expect(
      deriveCheckStatus([
        { conclusion: 'SUCCESS' },
        { conclusion: 'SUCCESS' },
        { conclusion: 'SUCCESS' }
      ])
    ).toBe('success')
  })

  it('returns failure when a single failure is among many successes', () => {
    expect(
      deriveCheckStatus([
        { conclusion: 'SUCCESS' },
        { conclusion: 'SUCCESS' },
        { conclusion: 'FAILURE' },
        { conclusion: 'SUCCESS' }
      ])
    ).toBe('failure')
  })

  it('returns failure for TIMED_OUT conclusion', () => {
    expect(deriveCheckStatus([{ conclusion: 'SUCCESS' }, { conclusion: 'TIMED_OUT' }])).toBe(
      'failure'
    )
  })

  it('returns failure for CANCELLED conclusion', () => {
    expect(deriveCheckStatus([{ conclusion: 'CANCELLED' }])).toBe('failure')
  })

  it('handles checks with state field instead of conclusion (FAILURE)', () => {
    expect(deriveCheckStatus([{ state: 'FAILURE' }])).toBe('failure')
  })

  it('handles checks with state field instead of conclusion (ERROR)', () => {
    expect(deriveCheckStatus([{ state: 'ERROR' }])).toBe('failure')
  })

  it('handles checks with state field PENDING', () => {
    expect(deriveCheckStatus([{ state: 'PENDING' }])).toBe('pending')
  })

  it('returns pending for QUEUED status', () => {
    expect(deriveCheckStatus([{ status: 'QUEUED' }])).toBe('pending')
  })

  it('returns pending for PENDING status', () => {
    expect(deriveCheckStatus([{ status: 'PENDING' }])).toBe('pending')
  })

  it('failure takes priority over pending', () => {
    expect(
      deriveCheckStatus([
        { status: 'IN_PROGRESS' },
        { conclusion: 'FAILURE' },
        { conclusion: 'SUCCESS' }
      ])
    ).toBe('failure')
  })
})

describe('mapCheckStatus', () => {
  it('maps PENDING to queued', () => {
    expect(mapCheckStatus('PENDING')).toBe('queued')
  })

  it('maps QUEUED to queued', () => {
    expect(mapCheckStatus('QUEUED')).toBe('queued')
  })

  it('maps IN_PROGRESS to in_progress', () => {
    expect(mapCheckStatus('IN_PROGRESS')).toBe('in_progress')
  })

  it('maps SUCCESS to completed', () => {
    expect(mapCheckStatus('SUCCESS')).toBe('completed')
  })

  it('maps any other value to completed', () => {
    expect(mapCheckStatus('FAILURE')).toBe('completed')
    expect(mapCheckStatus('UNKNOWN')).toBe('completed')
  })

  it('handles lowercase inputs', () => {
    expect(mapCheckStatus('pending')).toBe('queued')
    expect(mapCheckStatus('in_progress')).toBe('in_progress')
  })
})

describe('mapCheckConclusion', () => {
  it('maps SUCCESS to success', () => {
    expect(mapCheckConclusion('SUCCESS')).toBe('success')
  })

  it('maps PASS to success', () => {
    expect(mapCheckConclusion('PASS')).toBe('success')
  })

  it('maps FAILURE to failure', () => {
    expect(mapCheckConclusion('FAILURE')).toBe('failure')
  })

  it('maps FAIL to failure', () => {
    expect(mapCheckConclusion('FAIL')).toBe('failure')
  })

  it('maps CANCELLED to cancelled', () => {
    expect(mapCheckConclusion('CANCELLED')).toBe('cancelled')
  })

  it('maps TIMED_OUT to timed_out', () => {
    expect(mapCheckConclusion('TIMED_OUT')).toBe('timed_out')
  })

  it('maps SKIPPED to skipped', () => {
    expect(mapCheckConclusion('SKIPPED')).toBe('skipped')
  })

  it('maps PENDING to pending', () => {
    expect(mapCheckConclusion('PENDING')).toBe('pending')
  })

  it('maps QUEUED to pending', () => {
    expect(mapCheckConclusion('QUEUED')).toBe('pending')
  })

  it('maps IN_PROGRESS to pending', () => {
    expect(mapCheckConclusion('IN_PROGRESS')).toBe('pending')
  })

  it('maps NEUTRAL to neutral', () => {
    expect(mapCheckConclusion('NEUTRAL')).toBe('neutral')
  })

  it('returns null for unknown values', () => {
    expect(mapCheckConclusion('UNKNOWN')).toBeNull()
    expect(mapCheckConclusion('FOO')).toBeNull()
  })

  it('handles lowercase inputs', () => {
    expect(mapCheckConclusion('success')).toBe('success')
    expect(mapCheckConclusion('failure')).toBe('failure')
    expect(mapCheckConclusion('pending')).toBe('pending')
  })
})
