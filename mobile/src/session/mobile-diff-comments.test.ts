import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../src/shared/types'
import {
  addMobileDiffComment,
  formatDiffComments,
  normalizeMobileDiffComments,
  removeDeliveredMobileDiffComments,
  removeMobileDiffComments
} from './mobile-diff-comments'

function comment(overrides: Partial<DiffComment> & Pick<DiffComment, 'id'>): DiffComment {
  return {
    id: overrides.id,
    worktreeId: 'wt-1',
    filePath: 'src/app.ts',
    source: 'diff',
    lineNumber: 4,
    body: 'check this',
    createdAt: 100,
    side: 'modified',
    ...overrides
  }
}

describe('mobile diff comments', () => {
  it('normalizes persisted worktree metadata for mobile rendering', () => {
    expect(
      normalizeMobileDiffComments(
        [
          comment({ id: 'a' }),
          { id: 'missing-body', filePath: 'src/app.ts', lineNumber: 1, body: ' ' },
          null
        ],
        'wt-1'
      )
    ).toEqual([comment({ id: 'a' })])
  })

  it('creates trimmed modified-side comments', () => {
    const result = addMobileDiffComment([], {
      id: 'mobile-1',
      worktreeId: 'wt-1',
      filePath: 'src/app.ts',
      lineNumber: 8,
      body: '  Needs tests  ',
      createdAt: 200
    })

    expect(result.comment).toMatchObject({
      id: 'mobile-1',
      worktreeId: 'wt-1',
      filePath: 'src/app.ts',
      source: 'diff',
      lineNumber: 8,
      body: 'Needs tests',
      side: 'modified'
    })
    expect(result.comments).toHaveLength(1)
  })

  it('rejects blank comment bodies', () => {
    const existing = [comment({ id: 'a' })]
    const result = addMobileDiffComment(existing, {
      id: 'mobile-1',
      worktreeId: 'wt-1',
      filePath: 'src/app.ts',
      lineNumber: 8,
      body: '   ',
      createdAt: 200
    })

    expect(result.comment).toBeNull()
    expect(result.comments).toEqual(existing)
  })

  it('removes delivered comments by snapshot id without touching new notes', () => {
    expect(
      removeMobileDiffComments(
        [comment({ id: 'a' }), comment({ id: 'b' })],
        new Set(['a', 'missing'])
      )
    ).toEqual([comment({ id: 'b' })])
  })

  it('keeps a changed note when clearing an older delivered snapshot', () => {
    const delivered = comment({ id: 'a', body: 'old note' })

    expect(
      removeDeliveredMobileDiffComments(
        [comment({ id: 'a', body: 'new note' }), comment({ id: 'b' })],
        [delivered]
      )
    ).toEqual([comment({ id: 'a', body: 'new note' }), comment({ id: 'b' })])
  })

  it('uses the desktop-compatible prompt format', () => {
    expect(formatDiffComments([comment({ id: 'a', body: 'quote "this"' })])).toBe(
      ['File: src/app.ts', 'Line: 4', 'User comment: "quote \\"this\\""'].join('\n')
    )
  })
})
