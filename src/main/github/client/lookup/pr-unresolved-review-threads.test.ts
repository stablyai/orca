import { describe, expect, it } from 'vitest'
import { countUnresolvedReviewThreads } from './pr-unresolved-review-threads'

const thread = (isResolved: boolean, login: string, typename = 'User') => ({
  isResolved,
  comments: { nodes: [{ author: { __typename: typename, login } }] }
})

describe('countUnresolvedReviewThreads', () => {
  it('counts unresolved human threads and skips resolved and bot ones', () => {
    expect(
      countUnresolvedReviewThreads([
        thread(false, 'alice'),
        thread(true, 'alice'),
        thread(false, 'github-actions', 'Bot'),
        thread(false, 'coderabbitai'),
        null,
        { isResolved: false }
      ])
    ).toBe(2)
  })
})
