import { describe, expect, it } from 'vitest'
import {
  completeMobileDiffReviewState,
  createMobileDiffReviewState,
  markMobileDiffReviewFileReviewed,
  mergeMobileDiffReviewState
} from './mobile-diff-review-state'

const descriptor = {
  key: 'unstaged\0unstaged\0\0src/app.ts',
  filePath: 'src/app.ts',
  scope: 'unstaged',
  diffIdentity: 'd1'
} as const

describe('mobile diff review state', () => {
  it('invalidates reviewed state when refreshed identity changes', () => {
    const reviewed = markMobileDiffReviewFileReviewed(createMobileDiffReviewState(1), descriptor, 5)

    const merged = mergeMobileDiffReviewState(reviewed, [{ ...descriptor, diffIdentity: 'd2' }], 8)

    expect(merged.files[descriptor.key]?.reviewedAt).toBeUndefined()
    expect(merged.files[descriptor.key]?.reviewDiffIdentity).toBeUndefined()
  })

  it('drops completion when a refreshed identity invalidates a reviewed file', () => {
    const reviewed = markMobileDiffReviewFileReviewed(createMobileDiffReviewState(1), descriptor, 5)
    const completed = completeMobileDiffReviewState(reviewed, 6)

    const merged = mergeMobileDiffReviewState(completed, [{ ...descriptor, diffIdentity: 'd2' }], 8)

    expect(merged.completedAt).toBeUndefined()
  })
})
