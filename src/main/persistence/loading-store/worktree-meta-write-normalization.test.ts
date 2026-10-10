import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'

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
