import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import {
  buildMobileDiffReviewQueue,
  type BuildMobileDiffReviewQueueInput
} from './mobile-diff-review-queue'

function note(filePath: string, overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: filePath,
    filePath,
    worktreeId: 'workspace',
    lineNumber: 1,
    body: 'note',
    createdAt: 1,
    side: 'modified',
    ...overrides
  }
}
function input(comments: DiffComment[]): BuildMobileDiffReviewQueueInput {
  return {
    worktreeId: 'workspace',
    statusEntries: [
      { path: 'new.ts', oldPath: 'old.ts', area: 'unstaged', status: 'renamed' },
      { path: 'new.ts', oldPath: 'other.ts', area: 'staged', status: 'renamed' },
      { path: 'NEW.ts', area: 'untracked', status: 'untracked' }
    ],
    branchEntries: [{ path: 'new.ts', oldPath: 'old.ts', status: 'modified' }],
    comments,
    reviewState: { version: 1, files: {} }
  }
}

describe('mobile review note indexing', () => {
  it('preserves exact paths, legacy wildcards, rename/scope filters, and stale/unsent counts', () => {
    const comments = [
      note('new.ts'),
      note('new.ts', { scope: 'staged', sentAt: 0 }),
      note('new.ts', { scope: 'branch', oldPath: 'old.ts', diffIdentity: 'stale' }),
      note('new.ts', { oldPath: 'other.ts' }),
      note('new.ts', { oldPath: 'missing.ts' }),
      note('new.ts', { source: 'markdown' }),
      note('NEW.ts'),
      note('elsewhere.ts')
    ]
    const options = input(comments)
    const first = buildMobileDiffReviewQueue(options)
    expect(
      Object.fromEntries(
        first.map(({ scope, filePath, noteCount, unsentNoteCount, staleNoteCount }) => [
          `${scope}:${filePath}`,
          [noteCount, unsentNoteCount, staleNoteCount]
        ])
      )
    ).toEqual({
      'unstaged:NEW.ts': [1, 1, 0],
      'unstaged:new.ts': [1, 1, 0],
      'staged:new.ts': [3, 2, 0],
      'branch:new.ts': [2, 2, 1]
    })
    comments[0].sentAt = 2
    expect(
      buildMobileDiffReviewQueue(options).find((item) => item.scope === 'staged')?.unsentNoteCount
    ).toBe(1)
    expect(
      buildMobileDiffReviewQueue({ ...options, comments: [] }).every((item) => item.noteCount === 0)
    ).toBe(true)
  })

  it('reads comment paths in proportion to comments and matching rows, not their product', () => {
    let reads = 0
    const comments = Array.from({ length: 1000 }, (_, index) => ({
      ...note(`file-${index}.ts`),
      get filePath() {
        reads++
        return `file-${index}.ts`
      }
    }))
    const options = input(comments)
    options.statusEntries = comments.map((_, index) => ({
      path: `file-${index}.ts`,
      area: 'unstaged',
      status: 'modified'
    }))
    options.branchEntries = []
    const queue = buildMobileDiffReviewQueue(options)
    expect(queue.every((item) => item.noteCount === 1 && item.unsentNoteCount === 1)).toBe(true)
    expect(reads).toBe(2000)
  })

  it('skips indexing when there are no rows or just one row', () => {
    let reads = 0
    const comments = [
      {
        ...note('one.ts'),
        get filePath() {
          reads++
          return 'one.ts'
        }
      }
    ]
    const options = { ...input(comments), statusEntries: [], branchEntries: [] }
    expect(buildMobileDiffReviewQueue(options)).toEqual([])
    expect(reads).toBe(0)
    expect(
      buildMobileDiffReviewQueue({
        ...options,
        branchEntries: [{ path: 'one.ts', status: 'modified' }]
      })[0].noteCount
    ).toBe(1)
    expect(reads).toBe(1)
  })
})
