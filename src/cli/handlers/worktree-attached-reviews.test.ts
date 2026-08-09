import { describe, expect, it } from 'vitest'
import { getAttachedReviewsUpdate } from './worktree-attached-reviews'
import type { AttachedReview } from '../../shared/types'

function flags(entries: Record<string, string | boolean>): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

const PR = 'https://github.com/acme/app/pull/294'
const PR2 = 'https://github.com/acme/app/pull/295'

describe('getAttachedReviewsUpdate', () => {
  it('leaves the list alone when neither flag is present', () => {
    expect(getAttachedReviewsUpdate(flags({}), undefined)).toEqual({})
  })

  it('clears the list with --clear-prs alone', () => {
    expect(
      getAttachedReviewsUpdate(flags({ 'clear-prs': true }), [
        { provider: 'github', number: 1, url: PR }
      ])
    ).toEqual({ attachedReviews: [] })
  })

  it('appends to the current list so attaching one at a time works', () => {
    const current: AttachedReview[] = [{ provider: 'github', number: 294, url: PR }]
    const result = getAttachedReviewsUpdate(flags({ 'add-pr': PR2 }), current)
    expect(result.attachedReviews?.map((review) => review.number)).toEqual([294, 295])
  })

  it('replaces the list when both flags are passed', () => {
    const current: AttachedReview[] = [{ provider: 'github', number: 294, url: PR }]
    const result = getAttachedReviewsUpdate(flags({ 'add-pr': PR2, 'clear-prs': true }), current)
    expect(result.attachedReviews?.map((review) => review.number)).toEqual([295])
  })

  it('takes several urls in one call, comma-separated', () => {
    const result = getAttachedReviewsUpdate(flags({ 'add-pr': `${PR},${PR2}` }), undefined)
    expect(result.attachedReviews).toHaveLength(2)
  })

  it('takes a JSON array carrying the base ref and title', () => {
    // Why: neither can be derived from a PR link, and they are what tells two
    // reviews off the same branch apart on the card.
    const result = getAttachedReviewsUpdate(
      flags({
        'add-pr': JSON.stringify([
          { url: PR, baseRef: 'RELEASE/v1.14.0', title: 'feat: thing [v1.14.0]' },
          { url: PR2, baseRef: 'stage' }
        ])
      }),
      undefined
    )

    expect(result.attachedReviews).toEqual([
      {
        provider: 'github',
        number: 294,
        url: PR,
        baseRef: 'RELEASE/v1.14.0',
        title: 'feat: thing [v1.14.0]'
      },
      { provider: 'github', number: 295, url: PR2, baseRef: 'stage' }
    ])
  })

  it('still derives provider and number from the url, not from the JSON', () => {
    const result = getAttachedReviewsUpdate(
      flags({ 'add-pr': JSON.stringify([{ url: PR, number: 999, provider: 'gitlab' }]) }),
      undefined
    )
    expect(result.attachedReviews?.[0]).toMatchObject({ provider: 'github', number: 294 })
  })

  it('rejects malformed input instead of attaching a dead row', () => {
    for (const bad of ['[', '[{}]', '[{"url":"not-a-url"}]', '["a string"]', 'not-a-url']) {
      expect(() => getAttachedReviewsUpdate(flags({ 'add-pr': bad }), undefined)).toThrow()
    }
  })

  it('rejects a flag passed without a value', () => {
    expect(() => getAttachedReviewsUpdate(flags({ 'add-pr': true }), undefined)).toThrow(
      /Missing value for --add-pr/
    )
  })
})
