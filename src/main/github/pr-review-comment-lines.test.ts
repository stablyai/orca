import { describe, expect, it } from 'vitest'

import { getPRReviewCommentLineNumbersFromPatch } from './pr-review-comment-lines'

describe('getPRReviewCommentLineNumbersFromPatch', () => {
  it('returns modified-side context and added lines from GitHub patch hunks', () => {
    const patch = [
      '@@ -10,4 +20,5 @@ function example() {',
      ' const kept = true',
      '-const oldValue = 1',
      '+const newValue = 1',
      '+const added = true',
      ' return kept',
      '@@ -40,2 +51,2 @@ function other() {',
      '-removeMe()',
      '+addMe()',
      ' done()'
    ].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([20, 21, 22, 23, 51, 52])
  })

  it('returns an empty list when GitHub omits the patch', () => {
    expect(getPRReviewCommentLineNumbersFromPatch(undefined)).toEqual([])
  })
})
