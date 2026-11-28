import { expect, it } from 'vitest'
import type { DiffComment } from '../../../../shared/file-review/diff-comment-types'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'

it('keeps a newer same-ID edit when an older delivery receipt reaches the workspace host', () => {
  const draft: DiffComment = {
    id: 'draft',
    worktreeId: 'project::workspace',
    filePath: 'plan.md',
    lineNumber: 3,
    body: 'Draft',
    createdAt: 1,
    side: 'modified'
  }
  const matching = { ...draft, id: 'delivered', body: 'Delivered as written' }
  const edited = { ...draft, body: 'Edited after handoff' }
  const independent = { ...draft, id: 'new', body: 'Added on another device' }
  const before = mergeWorktreeMetaForWrite(undefined, { diffComments: [draft, matching] })
  const current = mergeWorktreeMetaForWrite(before, {
    diffCommentsBase: [draft, matching],
    diffComments: [edited, matching, independent]
  })

  const cleaned = mergeWorktreeMetaForWrite(current, {
    deliveredDiffCommentSnapshots: [draft, matching]
  })

  expect(cleaned.diffComments?.map((note) => note.body)).toEqual([
    'Edited after handoff',
    'Added on another device'
  ])
  expect(cleaned).not.toHaveProperty('deliveredDiffCommentSnapshots')

  const explicitClear = mergeWorktreeMetaForWrite(cleaned, {
    diffCommentsBase: [draft],
    diffComments: []
  })
  expect(explicitClear.diffComments?.map((note) => note.body)).toEqual(['Added on another device'])
})
