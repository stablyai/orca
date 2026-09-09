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
  it('re-derives an automatic display name from the current branch', () => {
    const worktree = mergeWorktree(
      'repo-1',
      { ...git, branch: 'refs/heads/main' },
      {
        displayName: 'feature',
        displayNameIsPinned: false,
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0
      }
    )

    expect(worktree.displayName).toBe('main')
    expect(worktree.displayNameMode).toBe('automatic')
  })

  it('treats legacy CLI labels as fixed display names', () => {
    const worktree = mergeWorktree('repo-1', git, {
      displayName: 'feature',
      cliProvenance: { kind: 'created-by-cli', createdAt: 1 },
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

    expect(worktree.displayNameMode).toBe('fixed')
  })

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

  it('projects optional GitHub PR suppression metadata', () => {
    const worktree = mergeWorktree('repo-1', git, {
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
    })

    expect(worktree.suppressedGitHubPR).toBe(42)
  })
})

describe('mergeWorktree reservation projection', () => {
  it('projects the persisted reservation binding so show and list expose it verbatim', () => {
    const reservation = {
      key: 'key-1',
      reservationId: 'res-1',
      sessionId: 'session-1',
      resourceKind: 'worktree' as const,
      ownershipGeneration: 4,
      issuer: 'openloop',
      boundAt: 9
    }

    const worktree = mergeWorktree('repo-1', git, {
      displayName: 'feature',
      reservation,
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

    expect(worktree.reservation).toEqual(reservation)
  })

  it('leaves an unreserved workspace with no binding to misread', () => {
    const worktree = mergeWorktree('repo-1', git, {
      displayName: 'feature',
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

    expect(worktree.reservation).toBeUndefined()
  })
})
