import { describe, expect, it } from 'vitest'
import { deriveCheckStatus } from './client'

describe('deriveCheckStatus', () => {
  it('returns neutral when no checks are present', () => {
    expect(deriveCheckStatus(null)).toBe('neutral')
    expect(deriveCheckStatus([])).toBe('neutral')
  })

  it('returns failure when a failed check is present', () => {
    expect(
      deriveCheckStatus([
        { status: 'QUEUED' },
        { conclusion: 'FAILURE' }
      ])
    ).toBe('failure')
  })

  it('returns pending when checks are still running', () => {
    expect(deriveCheckStatus([{ status: 'IN_PROGRESS' }])).toBe('pending')
  })

  it('returns success when all checks complete without failures', () => {
    expect(
      deriveCheckStatus([
        { conclusion: 'SUCCESS' },
        { conclusion: 'SKIPPED' }
      ])
    ).toBe('success')
  })
})
