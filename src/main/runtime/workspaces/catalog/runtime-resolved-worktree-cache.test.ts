import { describe, expect, it } from 'vitest'

import { getDefaultSettings, getDefaultUIState } from '../../../../shared/constants'
import {
  isWorkspaceNotificationMuted,
  type WorkspaceNotificationMuteDeps
} from '../../push/notifications/workspace-notification-mute'
import {
  RuntimeResolvedWorktreeCache,
  type ResolvedWorktreeSnapshot
} from './runtime-resolved-worktree-cache'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

function worktree(path: string, isMainWorktree = false): ResolvedWorktree {
  return {
    id: `repo-1::${path}`,
    repoId: 'repo-1',
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
    path,
    head: 'abc',
    branch: 'main',
    isBare: false,
    isMainWorktree,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path, head: 'abc', branch: 'main', isBare: false, isMainWorktree }
  }
}

function snapshot(...worktrees: ResolvedWorktree[]): ResolvedWorktreeSnapshot {
  return { worktrees, platformByRepoId: new Map() }
}

describe('RuntimeResolvedWorktreeCache.peekLastKnown', () => {
  it('keeps the last resolved listing after an invalidation', async () => {
    const cache = new RuntimeResolvedWorktreeCache()
    await cache.getSnapshot(async () => snapshot(worktree('/work/app')), 60_000, 0)

    cache.invalidateResolved()

    expect(cache.peek()).toBeNull()
    expect(cache.peekLastKnown()?.worktrees.map((item) => item.id)).toEqual(['repo-1::/work/app'])
  })

  it('moves to the newest resolved listing', async () => {
    const cache = new RuntimeResolvedWorktreeCache()
    await cache.getSnapshot(async () => snapshot(worktree('/first')), 60_000, 0)
    cache.invalidateResolved()
    await cache.getSnapshot(async () => snapshot(worktree('/second')), 60_000, 0)

    expect(cache.peekLastKnown()?.worktrees.map((item) => item.id)).toEqual(['repo-1::/second'])
  })

  it('is null until a listing has resolved', () => {
    const cache = new RuntimeResolvedWorktreeCache()
    cache.invalidateResolved()

    expect(cache.peekLastKnown()).toBeNull()
  })
})

describe('hidden-workspace push mute after an agent transition', () => {
  const store: WorkspaceNotificationMuteDeps['store'] = {
    getSettings: () => ({
      notifications: { ...getDefaultSettings('/home').notifications, notifyHiddenWorkspaces: false }
    }),
    getUI: () => ({ ...getDefaultUIState(), hideDefaultBranchWorkspace: true }),
    getRepo: () => undefined,
    getWorktreeMeta: () => undefined,
    getAllWorktreeLineage: () => ({}),
    getFolderWorkspaces: () => []
  }

  it('still mutes a default-branch main worktree once the transition cleared the cache', async () => {
    const cache = new RuntimeResolvedWorktreeCache()
    const main = worktree('/work/app', true)
    await cache.getSnapshot(async () => snapshot(main), 60_000, 0)

    // The transition writes sort stamps, which invalidate the cache before the push is sent.
    cache.invalidateResolved()

    const resolvedWorktrees = cache.peekLastKnown()?.worktrees ?? null
    expect(isWorkspaceNotificationMuted({ store, resolvedWorktrees }, main.id)).toBe(true)
  })
})
