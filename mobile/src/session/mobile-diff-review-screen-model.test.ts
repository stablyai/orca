import { describe, expect, it } from 'vitest'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import { nextReviewIndexAfterMarkReviewed } from './mobile-diff-review-screen-model'

function item(filePath: string): MobileDiffReviewQueueItem {
  return {
    key: `unstaged\0unstaged\0\0${filePath}`,
    scope: 'unstaged',
    area: 'unstaged',
    filePath,
    status: 'modified',
    title: filePath,
    subtitle: 'Unstaged',
    canStage: true,
    canUnstage: false,
    canDiscard: true,
    isGeneratedOrLockFile: false,
    diffIdentity: `diff:${filePath}`,
    noteCount: 0,
    unsentNoteCount: 0,
    staleNoteCount: 0,
    isReviewed: false,
    changedSinceReview: false
  }
}

describe('mobile diff review screen model', () => {
  it('keeps the next unreviewed file selected after the current file leaves the filter', () => {
    const queue = [item('a.ts'), item('b.ts'), item('c.ts')]

    expect(
      nextReviewIndexAfterMarkReviewed({
        currentIndex: 0,
        currentItemKey: queue[0].key,
        filter: 'unreviewed',
        filteredQueue: queue
      })
    ).toBe(0)
  })

  it('keeps direct next-file indexing for non-removing filters', () => {
    const queue = [item('a.ts'), item('b.ts'), item('c.ts')]

    expect(
      nextReviewIndexAfterMarkReviewed({
        currentIndex: 0,
        currentItemKey: queue[0].key,
        filter: 'all',
        filteredQueue: queue
      })
    ).toBe(1)
  })
})
