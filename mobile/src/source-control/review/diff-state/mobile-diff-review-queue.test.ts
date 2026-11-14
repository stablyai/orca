import { describe, expect, it } from 'vitest'
import type {
  DiffComment,
  MobileDiffReviewState
} from '../../../../../src/shared/diff-comment-types'
import type { MobileGitBranchChangeEntry } from '../../branches/git-compare-reply-schema'
import type { MobileGitStatusEntry } from '../../git/git-status-reply-schema'
import { buildMobileDiffReviewQueue } from './mobile-diff-review-queue'

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
  it('keeps scope, rename, and source matching when notes share a path', () => {
    const queue = buildMobileDiffReviewQueue({
      worktreeId: 'wt-1',
      statusEntries: [
        statusEntry({ area: 'unstaged', status: 'renamed', oldPath: 'old.ts' }),
        statusEntry({ area: 'staged' }),
        statusEntry({ path: 'other.ts' })
      ],
      branchEntries: [branchEntry({ path: 'src/app.ts', oldPath: 'old.ts' })],
      comments: [
        comment({ id: 'legacy', sentAt: 20 }),
        comment({ id: 'unstaged', scope: 'unstaged' }),
        comment({ id: 'staged', scope: 'staged' }),
        comment({ id: 'branch', scope: 'branch' }),
        comment({ id: 'rename', oldPath: 'old.ts', diffIdentity: 'stale' }),
        comment({ id: 'wrong-rename', oldPath: 'different.ts' }),
        comment({ id: 'markdown', source: 'markdown' }),
        comment({ id: 'unrelated', filePath: 'absent.ts' })
      ],
      reviewState: emptyReviewState
    })

    expect(
      queue.map(({ scope, filePath, noteCount, unsentNoteCount, staleNoteCount }) => ({
        scope,
        filePath,
        noteCount,
        unsentNoteCount,
        staleNoteCount
      }))
    ).toEqual([
      {
        scope: 'unstaged',
        filePath: 'other.ts',
        noteCount: 0,
        unsentNoteCount: 0,
        staleNoteCount: 0
      },
      {
        scope: 'unstaged',
        filePath: 'src/app.ts',
        noteCount: 3,
        unsentNoteCount: 2,
        staleNoteCount: 1
      },
      {
        scope: 'staged',
        filePath: 'src/app.ts',
        noteCount: 2,
        unsentNoteCount: 1,
        staleNoteCount: 0
      },
      {
        scope: 'branch',
        filePath: 'src/app.ts',
        noteCount: 3,
        unsentNoteCount: 2,
        staleNoteCount: 1
      }
    ])
  })
})
