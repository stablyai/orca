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

  it('forwards the rebase-recovery fields so the rebasing badge renders end-to-end', () => {
    const result = mergeWorktree(
      'repo1',
      {
        path: '/workspaces/feature',
        head: 'abc123',
        branch: '',
        isBare: false,
        isMainWorktree: false,
        rebasing: true,
        rebaseBranch: 'feature-x'
      },
      undefined
    )

    expect(result.rebasing).toBe(true)
    expect(result.rebaseBranch).toBe('feature-x')
  })

  it('omits the rebase fields for a normal branch worktree', () => {
    const result = mergeWorktree(
      'repo1',
      {
        path: '/workspaces/feature',
        head: 'abc123',
        branch: 'refs/heads/feature-x',
        isBare: false,
        isMainWorktree: false
      },
      undefined
    )

    expect(result.rebasing).toBeUndefined()
    expect(result.rebaseBranch).toBeUndefined()
  })
})
