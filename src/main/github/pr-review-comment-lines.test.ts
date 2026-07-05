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

  it('counts added lines whose content begins with ++', () => {
    // Inside a hunk, GitHub's per-file patch never carries a `+++ b/file` header
    // (those precede the first @@), so `+++count` is an added line of content `++count`
    // and must stay comment-eligible.
    const patch = ['@@ -1,1 +1,2 @@', ' const a = 1', '+++count'].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([1, 2])
  })

  it('does not treat removed lines whose content begins with -- as commentable', () => {
    // Asymmetry guard: removed lines never advance the new-side counter, so `--count`
    // (diff line `---count`) must not become commentable. Locks the intended difference
    // from the added-line case so a future "symmetric" edit can't regress it.
    const patch = ['@@ -1,2 +1,1 @@', ' const a = 1', '---count'].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([1])
  })
})
