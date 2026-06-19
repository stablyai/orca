import { describe, expect, it } from 'vitest'
import { shouldResolveHostedReviewStartPoint } from './hosted-review-start-point'

describe('shouldResolveHostedReviewStartPoint', () => {
  it('resolves PR and MR start points when no explicit base branch was selected', () => {
    expect(shouldResolveHostedReviewStartPoint({ type: 'pr' })).toBe(true)
    expect(shouldResolveHostedReviewStartPoint({ type: 'mr', baseBranchOverride: '' })).toBe(true)
  })

  it('does not resolve a hosted review start point when the user selected a base branch', () => {
    expect(
      shouldResolveHostedReviewStartPoint({
        type: 'pr',
        baseBranchOverride: 'origin/feature/manual'
      })
    ).toBe(false)
    expect(
      shouldResolveHostedReviewStartPoint({
        type: 'mr',
        baseBranchOverride: 'origin/release'
      })
    ).toBe(false)
  })

  it('never resolves start points for issues', () => {
    expect(shouldResolveHostedReviewStartPoint({ type: 'issue' })).toBe(false)
  })
})
