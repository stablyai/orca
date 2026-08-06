import { describe, expect, it } from 'vitest'
import type { HostedReviewDecision } from '../../../src/shared/hosted-review'
import { mobileI18n } from '../i18n/mobile-i18n'
import {
  getHostedChecksLabel,
  getHostedReviewLabel,
  getHostedReviewSignalTone
} from './mobile-hosted-check-status'

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

  it('keeps shared provider summaries localized on mobile', async () => {
    const initialLocale = mobileI18n.language
    await mobileI18n.changeLanguage('es')
    try {
      expect(
        getHostedChecksLabel({
          checksSummary: {
            state: 'success',
            total: 2,
            passed: 2,
            failed: 0,
            pending: 0,
            neutral: 0
          }
        })
      ).toBe('2/2 pasó')
    } finally {
      await mobileI18n.changeLanguage(initialLocale)
    }
  })

  it('accepts provider-neutral GitHub status fields without a shared work-item type', () => {
    expect(
      getHostedReviewSignalTone(
        { reviewDecision: 'approved', reviewRequests: [], mergeable: 'UNKNOWN' },
        'review'
      )
    ).toBe('success')
  })

  it('renders hydrated GitLab approval, merge, and check states', () => {
    expect(getHostedReviewLabel({ reviewDecision: 'review_required', reviewerCount: 2 })).toBe(
      'Review required'
    )
    expect(
      getHostedReviewSignalTone(
        {
          reviewDecision: 'review_required',
          reviewerCount: 2,
          mergeable: 'MERGEABLE',
          checksSummary: {
            state: 'success',
            total: 1,
            passed: 1,
            failed: 0,
            pending: 0,
            neutral: 0
          }
        },
        'review'
      )
    ).toBe('warning')
    expect(getHostedReviewSignalTone({ mergeable: 'MERGEABLE' }, 'merge')).toBe('success')
    expect(getHostedReviewSignalTone({ reviewDecision: 'approved' }, 'review')).toBe('success')
    expect(getHostedReviewSignalTone({ mergeable: 'CONFLICTING' }, 'merge')).toBe('danger')
  })

  it('renders a shared typed GitLab review decision', () => {
    const reviewDecision: HostedReviewDecision = 'changes_requested'

    expect(getHostedReviewLabel({ reviewDecision })).toBe('Changes requested')
    expect(getHostedReviewSignalTone({ reviewDecision }, 'review')).toBe('danger')
  })

  it('keeps missing GitLab enrichment neutral', () => {
    expect(getHostedReviewLabel({})).toBe('No reviewers')
    expect(getHostedReviewSignalTone({}, 'review')).toBe('neutral')
    expect(getHostedReviewSignalTone({}, 'merge')).toBe('neutral')
  })
})
