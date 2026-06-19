import { describe, expect, it } from 'vitest'
import { mergeWorktree } from './worktree-logic'

describe('mergeWorktree creation agent metadata', () => {
  it('forwards the creation agent metadata', () => {
    const result = mergeWorktree(
      'repo1',
      {
        path: '/workspaces/feature',
        head: 'abc123',
        branch: 'refs/heads/feature-x',
        isBare: false,
        isMainWorktree: false
      },
      {
        displayName: '',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdWithAgent: 'codex'
      }
    )

    expect(result.createdWithAgent).toBe('codex')
  })
})
