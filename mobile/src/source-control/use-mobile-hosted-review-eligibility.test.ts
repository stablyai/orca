import { describe, expect, it } from 'vitest'
import {
  acceptsMobileHostedReviewEligibilityLoad,
  buildMobileHostedReviewEligibilityLoadKey,
  eligibilityStateAfterMobileHostedReviewError,
  shouldFetchMobileHostedReviewEligibility
} from './use-mobile-hosted-review-eligibility'

describe('mobile hosted review eligibility loader core', () => {
  it('does not fetch while disconnected or detached', () => {
    expect(
      shouldFetchMobileHostedReviewEligibility({
        client: { sendRequest: async () => ({ ok: true }) } as never,
        connState: 'disconnected',
        branch: 'feature'
      })
    ).toBe(false)
    expect(
      shouldFetchMobileHostedReviewEligibility({
        client: { sendRequest: async () => ({ ok: true }) } as never,
        connState: 'connected',
        branch: null
      })
    ).toBe(false)
  })

  it('accepts only the latest generation for the current worktree branch identity', () => {
    const first = buildMobileHostedReviewEligibilityLoadKey({
      worktreeId: 'wt-1',
      branch: 'feature-a',
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false
    })
    const second = buildMobileHostedReviewEligibilityLoadKey({
      worktreeId: 'wt-1',
      branch: 'feature-b',
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false
    })

    expect(
      acceptsMobileHostedReviewEligibilityLoad({
        generation: 1,
        currentGeneration: 2,
        identity: first.identity,
        currentIdentity: second.identity
      })
    ).toBe(false)
  })

  it('fails closed after errors', () => {
    expect(eligibilityStateAfterMobileHostedReviewError()).toEqual({ kind: 'error' })
  })
})
