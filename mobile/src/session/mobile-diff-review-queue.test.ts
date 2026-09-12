import { describe, expect, it } from 'vitest'
import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/diff-comment-types'
import type { MobileGitBranchChangeEntry } from '../source-control/mobile-branch-compare'
import type { MobileGitStatusEntry } from '../source-control/mobile-git-status'
import {
  buildMobileDiffReviewQueue,
  createMobileDiffReviewFileKey,
  filterMobileDiffReviewQueue,
  summarizeMobileDiffReviewQueue,
  type MobileDiffReviewQueueItem
} from './mobile-diff-review-queue'

const emptyReviewState: MobileDiffReviewState = { version: 1, files: {} }

function statusEntry(overrides: Partial<MobileGitStatusEntry>): MobileGitStatusEntry {
  return {
    path: 'src/app.ts',
    status: 'modified',
    area: 'unstaged',
    ...overrides
  }
}

function branchEntry(overrides: Partial<MobileGitBranchChangeEntry>): MobileGitBranchChangeEntry {
  return {
    path: 'src/branch.ts',
    status: 'modified',
    ...overrides
  }
}

function comment(overrides: Partial<DiffComment> & Pick<DiffComment, 'id'>): DiffComment {
  const { id, ...rest } = overrides
  return {
    id,
    worktreeId: 'wt-1',
    filePath: 'src/app.ts',
    source: 'diff',
    lineNumber: 2,
    body: 'note',
    createdAt: 10,
    side: 'modified',
    ...rest
  }
}

describe('mobile diff review queue', () => {
  it('builds unstaged, staged, and branch entries in review order', () => {
    const queue = buildMobileDiffReviewQueue({
      worktreeId: 'wt-1',
      statusEntries: [
        statusEntry({ path: 'z.ts', area: 'staged' }),
        statusEntry({ path: 'a.ts', area: 'unstaged' })
      ],
      branchEntries: [branchEntry({ path: 'b.ts' })],
      branchHeadOid: 'head',
      branchMergeBase: 'base',
      comments: [],
      reviewState: emptyReviewState
    })

    expect(queue.map((item) => `${item.scope}:${item.filePath}`)).toEqual([
      'unstaged:a.ts',
      'staged:z.ts',
      'branch:b.ts'
    ])
  })

  it('uses stable keys for renamed files', () => {
    expect(createMobileDiffReviewFileKey('branch', 'branch', 'new.ts', 'old.ts')).toBe(
      'branch\0branch\0old.ts\0new.ts'
    )
  })

  it('counts unsent and stale notes for matching review items', () => {
    const queue = buildMobileDiffReviewQueue({
      worktreeId: 'wt-1',
      statusEntries: [statusEntry({ path: 'src/app.ts', area: 'unstaged' })],
      branchEntries: [],
      comments: [
        comment({ id: 'a', scope: 'unstaged', diffIdentity: 'stale' }),
        comment({ id: 'b', scope: 'unstaged', sentAt: 20 })
      ],
      reviewState: emptyReviewState
    })

    expect(queue[0]).toMatchObject({ noteCount: 2, unsentNoteCount: 1, staleNoteCount: 1 })
  })

  it('filters unreviewed files and noted files', () => {
    const reviewState: MobileDiffReviewState = {
      version: 1,
      files: {
        [createMobileDiffReviewFileKey('unstaged', 'unstaged', 'a.ts')]: {
          key: createMobileDiffReviewFileKey('unstaged', 'unstaged', 'a.ts'),
          filePath: 'a.ts',
          scope: 'unstaged',
          reviewedAt: 11,
          reviewDiffIdentity: 'wrong'
        }
      }
    }
    const queue = buildMobileDiffReviewQueue({
      worktreeId: 'wt-1',
      statusEntries: [
        statusEntry({ path: 'a.ts', area: 'unstaged' }),
        statusEntry({ path: 'b.ts', area: 'unstaged' })
      ],
      branchEntries: [],
      comments: [comment({ id: 'a', filePath: 'b.ts' })],
      reviewState
    })

    expect(filterMobileDiffReviewQueue(queue, 'unreviewed').map((item) => item.filePath)).toEqual([
      'a.ts',
      'b.ts'
    ])
    expect(filterMobileDiffReviewQueue(queue, 'notes').map((item) => item.filePath)).toEqual([
      'b.ts'
    ])
  })

  it('summarizes review counts in one pass without rereading item fields', () => {
    const entryCount = 1_000
    const reads = { isReviewed: 0, scope: 0, canStage: 0 }
    let expectedReviewedCount = 0
    let expectedReviewedUnstagedItems = 0
    let expectedReviewedUnstagedCount = 0
    const queue = Array.from({ length: entryCount }, (_, index) => {
      const isReviewed = index % 2 === 0
      const scope = index % 3 === 0 ? 'unstaged' : 'staged'
      const canStage = index % 5 === 0
      if (isReviewed) {
        expectedReviewedCount += 1
        if (scope === 'unstaged') {
          expectedReviewedUnstagedItems += 1
          if (canStage) {
            expectedReviewedUnstagedCount += 1
          }
        }
      }
      const item = {} as MobileDiffReviewQueueItem
      Object.defineProperties(item, {
        isReviewed: {
          enumerable: true,
          get: () => {
            reads.isReviewed += 1
            return isReviewed
          }
        },
        scope: {
          enumerable: true,
          get: () => {
            reads.scope += 1
            return scope
          }
        },
        canStage: {
          enumerable: true,
          get: () => {
            reads.canStage += 1
            return canStage
          }
        }
      })
      return item
    })

    expect(summarizeMobileDiffReviewQueue(queue)).toEqual({
      reviewedCount: expectedReviewedCount,
      reviewedUnstagedCount: expectedReviewedUnstagedCount
    })
    expect(reads).toEqual({
      isReviewed: entryCount,
      scope: expectedReviewedCount,
      canStage: expectedReviewedUnstagedItems
    })
  })
})
