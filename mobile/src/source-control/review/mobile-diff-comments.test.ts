import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../../src/shared/diff-comment-types'
import { removeDeliveredMobileDiffComments } from './mobile-diff-comments'

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

describe('mobile diff comments', () => {
  it('keeps a changed note when clearing an older delivered snapshot', () => {
    const delivered = comment({ id: 'a', body: 'old note' })

    expect(
      removeDeliveredMobileDiffComments(
        [comment({ id: 'a', body: 'new note' }), comment({ id: 'b' })],
        [delivered]
      )
    ).toEqual([comment({ id: 'a', body: 'new note' }), comment({ id: 'b' })])
  })
})
