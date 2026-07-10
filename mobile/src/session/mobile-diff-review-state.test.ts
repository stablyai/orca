import { describe, expect, it } from 'vitest'
import {
  buildMobileDiffIdentity,
  clearMobileDiffReviewFileReviewed,
  completeMobileDiffReviewState,
  createMobileDiffReviewState,
  isMobileDiffReviewFileReviewed,
  markMobileDiffReviewFileReviewed,
  mergeMobileDiffReviewState,
  normalizeMobileDiffReviewState
} from './mobile-diff-review-state'

const descriptor = {
  key: 'unstaged\0unstaged\0\0src/app.ts',
  filePath: 'src/app.ts',
  scope: 'unstaged',
  diffIdentity: 'd1'
} as const

describe('mobile diff review state', () => {
  it('normalizes persisted review metadata', () => {
    expect(
      normalizeMobileDiffReviewState({
        version: 1,
        updatedAt: 9,
        files: {
          [descriptor.key]: {
            key: descriptor.key,
            filePath: 'src/app.ts',
            scope: 'unstaged',
            reviewedAt: 10,
            reviewDiffIdentity: 'd1'
          },
          broken: { filePath: '', scope: 'staged' }
        }
      })
    ).toEqual({
      version: 1,
      updatedAt: 9,
      completedAt: undefined,
      files: {
        [descriptor.key]: {
          key: descriptor.key,
          filePath: 'src/app.ts',
          oldPath: undefined,
          scope: 'unstaged',
          lastOpenedAt: undefined,
          lastSeenDiffIdentity: undefined,
          reviewedAt: 10,
          reviewDiffIdentity: 'd1'
        }
      }
    })
  })

  it('marks files reviewed against the current diff identity', () => {
    const state = markMobileDiffReviewFileReviewed(createMobileDiffReviewState(1), descriptor, 5)

    expect(isMobileDiffReviewFileReviewed(state.files[descriptor.key], 'd1')).toBe(true)
    expect(isMobileDiffReviewFileReviewed(state.files[descriptor.key], 'd2')).toBe(false)
  })

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

  it('keeps completion when refreshed identities are unchanged', () => {
    const reviewed = markMobileDiffReviewFileReviewed(createMobileDiffReviewState(1), descriptor, 5)
    const completed = completeMobileDiffReviewState(reviewed, 6)

    const merged = mergeMobileDiffReviewState(completed, [descriptor], 8)

    expect(merged.completedAt).toBe(6)
    expect(merged.files[descriptor.key]?.reviewedAt).toBe(5)
  })

  it('clears reviewed state for manual unreview', () => {
    const reviewed = markMobileDiffReviewFileReviewed(createMobileDiffReviewState(1), descriptor, 5)

    const unreviewed = clearMobileDiffReviewFileReviewed(reviewed, descriptor.key, 8)

    expect(unreviewed.files[descriptor.key]?.reviewedAt).toBeUndefined()
    expect(unreviewed.files[descriptor.key]?.reviewDiffIdentity).toBeUndefined()
    expect(unreviewed.updatedAt).toBe(8)
  })

  it('builds stable content identities from ordered parts', () => {
    expect(buildMobileDiffIdentity(['a', 'b'])).toBe(buildMobileDiffIdentity(['a', 'b']))
    expect(buildMobileDiffIdentity(['a', 'b'])).not.toBe(buildMobileDiffIdentity(['ab']))
  })
})
