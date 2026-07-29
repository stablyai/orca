import { describe, expect, it } from 'vitest'
import {
  createMobileDiffReviewFileKey,
  filterMobileDiffReviewQueue,
  type MobileDiffReviewQueueItem
} from './mobile-diff-review-queue'
import { findMobileDiffReviewInitialIndex } from './mobile-diff-review-positioning'

function item(
  filePath: string,
  area: MobileDiffReviewQueueItem['area'],
  oldPath?: string
): MobileDiffReviewQueueItem {
  const scope = area === 'staged' || area === 'branch' ? area : 'unstaged'
  return {
    key: createMobileDiffReviewFileKey(scope, area, filePath, oldPath),
    scope,
    area,
    filePath,
    oldPath,
    status: oldPath ? 'renamed' : area === 'untracked' ? 'untracked' : 'modified',
    title: filePath,
    subtitle: scope,
    canStage: area === 'unstaged' || area === 'untracked',
    canUnstage: area === 'staged',
    canDiscard: area !== 'staged' && area !== 'branch',
    isGeneratedOrLockFile: false,
    diffIdentity: `diff:${filePath}`,
    noteCount: 0,
    unsentNoteCount: 0,
    staleNoteCount: 0,
    isReviewed: false,
    changedSinceReview: false
  }
}

describe('mobile diff review positioning', () => {
  it('selects an untracked file without changing the all-files filter', () => {
    const queue = [
      item('a.ts', 'unstaged'),
      item('new file.ts', 'untracked'),
      item('b.ts', 'staged')
    ]
    const filtered = filterMobileDiffReviewQueue(queue, 'all')

    expect(
      findMobileDiffReviewInitialIndex(filtered, {
        filePath: 'new file.ts',
        area: 'untracked'
      })
    ).toBe(1)
    expect(filtered).toHaveLength(3)
  })

  it('matches renamed files by oldPath through the queue key', () => {
    const queue = [item('new.ts', 'branch', 'old.ts'), item('other.ts', 'branch')]

    expect(
      findMobileDiffReviewInitialIndex(queue, {
        filePath: 'old.ts',
        area: 'branch'
      })
    ).toBe(0)
  })

  it('falls back to the first file when the target is missing', () => {
    const queue = [item('a.ts', 'unstaged'), item('b.ts', 'staged')]

    expect(
      findMobileDiffReviewInitialIndex(queue, {
        filePath: 'missing.ts',
        area: 'unstaged'
      })
    ).toBe(0)
  })
})
