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

  it('returns an empty list for empty patch string', () => {
    expect(getPRReviewCommentLineNumbersFromPatch('')).toEqual([])
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

  it('handles single-line hunks with count = 1', () => {
    const patch = ['@@ -5,0 +6,1 @@', '+new line'].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([6])
  })

  it('handles hunks with only context lines', () => {
    const patch = ['@@ -1,2 +1,2 @@', ' line 1', ' line 2'].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([1, 2])
  })

  it('handles multiple consecutive hunks', () => {
    const patch = ['@@ -1,1 +1,2 @@', '+line 1', ' line 2', '@@ -3,1 +4,1 @@', ' line 4'].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([1, 2, 4])
  })

  it('handles hunks with no added lines', () => {
    const patch = ['@@ -1,2 +1,0 @@', '-removed line 1', '-removed line 2'].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([])
  })

  it('ignores no-newline-at-end-of-file markers', () => {
    const patch = ['@@ -1,1 +1,2 @@', ' line 1', '+line 2', '\\ No newline at end of file'].join(
      '\n'
    )

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([1, 2])
  })

  it('handles hunks with large line counts', () => {
    const patch = [
      '@@ -1,0 +100,50 @@',
      ...Array(50)
        .fill(0)
        .map((_, i) => `+line ${i}`)
    ].join('\n')

    const result = getPRReviewCommentLineNumbersFromPatch(patch)
    expect(result).toHaveLength(50)
    expect(result[0]).toBe(100)
    expect(result[49]).toBe(149)
  })

  it('handles patches with only removed lines', () => {
    const patch = ['@@ -1,3 +1,0 @@', '-removed 1', '-removed 2', '-removed 3'].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([])
  })

  it('handles mixed add/remove in same hunk', () => {
    const patch = ['@@ -1,3 +1,3 @@', ' context', '-removed', '+added', ' context'].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([1, 2, 3])
  })

  it('handles hunk header with implicit count of 1', () => {
    const patch = ['@@ -5,0 +6 @@', '+new line'].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([6])
  })

  it('handles patches with trailing newlines', () => {
    const patch = ['@@ -1,1 +1,1 @@', ' line 1', '', ''].join('\n')

    expect(getPRReviewCommentLineNumbersFromPatch(patch)).toEqual([1])
  })
})
