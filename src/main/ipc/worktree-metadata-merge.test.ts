import { describe, expect, it } from 'vitest'
import { canonicalWorktreeIdentity } from '../../shared/worktree/identity'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { mergeWorktree } from './worktree-metadata-merge'

const git: GitWorktreeInfo = {
  path: '/workspace/feature',
  head: 'abc123',
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false
}

describe('mergeWorktree identity projection', () => {
  it('publishes canonical identity when host and instance metadata are known', () => {
    const worktree = mergeWorktree('repo-1', git, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      hostId: 'ssh:build-box',
      displayName: 'Feature',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    })

    expect(worktree.identity).toEqual({
      key: canonicalWorktreeIdentity({
        worktreeId: worktree.id,
        executionHostId: 'ssh:build-box',
        instanceId: '11111111-1111-4111-8111-111111111111'
      }),
      executionHostId: 'ssh:build-box',
      instanceId: '11111111-1111-4111-8111-111111111111'
    })
  })

  it('omits canonical identity for legacy metadata without a proven host', () => {
    const worktree = mergeWorktree('repo-1', git, undefined)

    expect(worktree.identity).toBeUndefined()
  })
})
