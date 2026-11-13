import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'
import { CLEARED_HOSTED_REVIEW_LINK_UPDATES } from '../../../../shared/worktree/hosted-review-links'

const existingMeta: WorktreeMeta = {
  displayName: 'Feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  suppressedGitHubPR: 42,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

function note(id: string): DiffComment {
  return {
    id,
    worktreeId: 'wt',
    filePath: 'a.ts',
    lineNumber: 1,
    body: id,
    createdAt: 1,
    side: 'modified'
  }
}

describe('worktree metadata write normalization', () => {
  it('applies a stale review-note writer’s own add and delete without dropping notes added elsewhere', () => {
    const existing = { ...existingMeta, diffComments: [note('a'), note('desktop')] }
    const updated = mergeWorktreeMetaForWrite(existing, {
      diffCommentsBase: [note('a')],
      diffComments: [note('phone')]
    })

    expect(updated.diffComments).toEqual([note('desktop'), note('phone')])
    expect(updated).not.toHaveProperty('diffCommentsBase')
  })

  it('retains all five PRs while each successive branch clears its active review', () => {
    let meta = existingMeta
    const numbers = [32201, 32206, 32211, 32216, 32218]
    for (const number of numbers) {
      meta = mergeWorktreeMetaForWrite(meta, {
        linkedPR: number,
        pushTarget: { remoteName: 'origin', branchName: `review-${number}` }
      })
      meta = mergeWorktreeMetaForWrite(meta, CLEARED_HOSTED_REVIEW_LINK_UPDATES)
      expect(meta.linkedPR).toBeNull()
      expect(meta.pushTarget).toBeUndefined()
    }
    expect(meta.linkedItems?.map((item) => item.number)).toEqual(numbers)

    const selected = mergeWorktreeMetaForWrite(meta, { linkedPR: 32211 })
    const unlinked = mergeWorktreeMetaForWrite(selected, { linkedPR: null })
    expect(unlinked.linkedItems?.map((item) => item.number)).toEqual([32201, 32206, 32216, 32218])
  })

  it('keeps a valid plugin task link and drops a malformed one', () => {
    const link = {
      pluginKey: 'orca-samples.roadmap',
      sourceId: 'roadmap',
      itemId: 'plan',
      title: 'Plan',
      sourceTitle: 'Roadmap'
    }

    expect(
      mergeWorktreeMetaForWrite(existingMeta, { linkedPluginTask: link }).linkedPluginTask
    ).toEqual(link)
    expect(
      mergeWorktreeMetaForWrite(existingMeta, {
        linkedPluginTask: { ...link, pluginKey: 'not a key' }
      }).linkedPluginTask
    ).toBeNull()
    expect(mergeWorktreeMetaForWrite(existingMeta, { comment: 'x' })).not.toHaveProperty(
      'linkedPluginTask'
    )
  })
})
