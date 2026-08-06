import { afterEach, describe, expect, it } from 'vitest'
import { formatDiffComment as formatDesktopDiffComment } from '../../../src/shared/diff-comments-format'
import type { DiffComment } from '../../../src/shared/types'
import { mobileI18n } from '../i18n/mobile-i18n'
import {
  addMobileDiffComment,
  formatDiffComments,
  formatMobileDiffReviewPrompt,
  normalizeMobileDiffComments,
  removeDeliveredMobileDiffComments,
  removeMobileDiffComments
} from './mobile-diff-comments'

const INITIAL_LOCALE = mobileI18n.language

afterEach(async () => {
  await mobileI18n.changeLanguage(INITIAL_LOCALE)
})

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

  it('creates file-level scoped comments', () => {
    const result = addMobileDiffComment([], {
      id: 'mobile-1',
      worktreeId: 'wt-1',
      filePath: 'src/app.ts',
      oldPath: 'src/old-app.ts',
      lineNumber: 0,
      body: '  File note  ',
      createdAt: 200,
      scope: 'branch',
      diffIdentity: 'd1'
    })

    expect(result.comment).toMatchObject({
      lineNumber: 0,
      body: 'File note',
      scope: 'branch',
      oldPath: 'src/old-app.ts',
      diffIdentity: 'd1'
    })
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

  it('keeps the agent envelope canonical when the mobile UI is translated', async () => {
    const note = comment({ id: 'a', startLine: 2, lineNumber: 4 })
    await mobileI18n.changeLanguage('es')

    expect(
      mobileI18n.t('pairConfirm.pairingFailed', {
        errorMessage: 'fallo'
      })
    ).toBe('Error de emparejamiento: fallo')
    expect(formatDiffComments([note])).toBe(formatDesktopDiffComment(note))
  })

  it('formats file-level notes with file scope', () => {
    expect(formatDiffComments([comment({ id: 'a', lineNumber: 0 })])).toBe(
      ['File: src/app.ts', 'Scope: file', 'User comment: "check this"'].join('\n')
    )
  })

  it('wraps sent review notes in the mobile agent prompt', () => {
    expect(formatMobileDiffReviewPrompt([comment({ id: 'a' })])).toBe(
      [
        'You are reviewing the current worktree. Address the following mobile review notes.',
        '',
        'File: src/app.ts',
        'Line: 4',
        'User comment: "check this"',
        '',
        'After applying fixes:',
        '1. Summarize changed files.',
        '2. Run relevant tests.',
        '3. Tell me if anything remains risky.'
      ].join('\n')
    )
  })

  it('keeps review metadata while normalizing persisted notes', () => {
    expect(
      normalizeMobileDiffComments(
        [
          comment({
            id: 'a',
            lineNumber: 0,
            updatedAt: 200,
            sentAt: 300,
            scope: 'staged',
            oldPath: 'src/old.ts',
            diffIdentity: 'd1'
          })
        ],
        'wt-1'
      )
    ).toEqual([
      comment({
        id: 'a',
        lineNumber: 0,
        updatedAt: 200,
        sentAt: 300,
        scope: 'staged',
        oldPath: 'src/old.ts',
        diffIdentity: 'd1'
      })
    ])
  })
})
