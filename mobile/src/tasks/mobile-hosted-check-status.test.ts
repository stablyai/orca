import { describe, expect, it } from 'vitest'
import { getHostedChecksLabel, getHostedReviewSignalTone } from './mobile-hosted-check-status'

describe('mobile hosted check status', () => {
  it('renders a hydrated neutral GitLab summary as unresolved checks', () => {
    const summary = {
      state: 'neutral' as const,
      total: 2,
      passed: 1,
      failed: 0,
      pending: 0,
      neutral: 1
    }
    expect(getHostedChecksLabel({ checksSummary: summary })).toBe('Unresolved checks')
    expect(getHostedReviewSignalTone({ checksSummary: summary }, 'checks')).toBe('neutral')
  })

  it('accepts provider-neutral GitHub status fields without a shared work-item type', () => {
    expect(
      getHostedReviewSignalTone(
        { reviewDecision: 'APPROVED', reviewRequests: [], mergeable: 'UNKNOWN' },
        'review'
      )
    ).toBe('success')
  })
})
