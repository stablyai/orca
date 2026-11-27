import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
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

describe('worktree metadata write normalization of plugin task links', () => {
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
