import { describe, expect, it } from 'vitest'
import {
  moveMobileDiffReviewSelection,
  resolveMobileDiffReviewSelection,
  selectMobileDiffReviewIndex
} from './mobile-diff-review-selection'

const queue = (...keys: string[]) => keys.map((key) => ({ key }))

describe('mobile diff review selection', () => {
  it('follows the open file when files before it leave the queue', () => {
    const selection = selectMobileDiffReviewIndex(queue('a', 'b', 'c', 'd'), 1)
    expect(resolveMobileDiffReviewSelection(queue('b', 'c', 'd'), selection)).toBe(0)
  })

  it('lands on the file that took its place when the open file leaves', () => {
    const selection = selectMobileDiffReviewIndex(queue('a', 'b', 'c'), 1)
    expect(resolveMobileDiffReviewSelection(queue('a', 'c'), selection)).toBe(1)
    const last = selectMobileDiffReviewIndex(queue('a', 'b', 'c'), 2)
    expect(resolveMobileDiffReviewSelection(queue('a', 'b'), last)).toBe(1)
  })

  it('wraps next and previous', () => {
    const files = queue('a', 'b', 'c')
    const last = selectMobileDiffReviewIndex(files, 2)
    expect(moveMobileDiffReviewSelection(files, last, 'next').key).toBe('a')
    expect(
      moveMobileDiffReviewSelection(files, selectMobileDiffReviewIndex(files, 0), 'previous').key
    ).toBe('c')
  })
})
