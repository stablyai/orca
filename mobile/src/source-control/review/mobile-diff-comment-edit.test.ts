import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../../src/shared/diff-comment-types'
import {
  clearSentMobileDiffComments,
  countUnsentMobileDiffComments,
  getUnsentMobileDiffComments,
  markMobileDiffCommentsSent
} from './mobile-diff-comment-edit'

function comment(overrides: Partial<DiffComment> & Pick<DiffComment, 'id'>): DiffComment {
  const { id, ...rest } = overrides
  return {
    id,
    worktreeId: 'wt-1',
    filePath: 'src/app.ts',
    source: 'diff',
    lineNumber: 4,
    body: 'check this',
    createdAt: 100,
    side: 'modified',
    ...rest
  }
}

describe('mobile diff comment editing', () => {
  it('marks notes sent and excludes them from unsent counts', () => {
    const comments = markMobileDiffCommentsSent(
      [comment({ id: 'a' }), comment({ id: 'b' })],
      new Set(['a']),
      250
    )

    expect(comments[0]?.sentAt).toBe(250)
    expect(countUnsentMobileDiffComments(comments)).toBe(1)
    expect(getUnsentMobileDiffComments(comments)).toEqual([comment({ id: 'b' })])
  })

  it('clears sent notes without removing unsent edits', () => {
    expect(
      clearSentMobileDiffComments([comment({ id: 'a', sentAt: 1 }), comment({ id: 'b' })])
    ).toEqual([comment({ id: 'b' })])
  })
})
