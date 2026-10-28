import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'
import { CLEARED_HOSTED_REVIEW_LINK_UPDATES } from '../../../shared/worktree/hosted-review-links'

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

describe('worktree metadata write normalization', () => {
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

  it('clears GitHub PR suppression on every positive linked PR update', () => {
    const updated = mergeWorktreeMetaForWrite(existingMeta, {
      linkedPR: 42,
      suppressedGitHubPR: 42
    })

    expect(updated.linkedPR).toBe(42)
    expect(updated.suppressedGitHubPR).toBeNull()
  })

  it('preserves suppression for clears and unrelated metadata updates', () => {
    expect(mergeWorktreeMetaForWrite(existingMeta, { linkedPR: null }).suppressedGitHubPR).toBe(42)
    expect(mergeWorktreeMetaForWrite(existingMeta, { comment: 'note' }).suppressedGitHubPR).toBe(42)
  })
})
