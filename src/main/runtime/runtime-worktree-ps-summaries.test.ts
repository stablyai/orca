import { describe, expect, it } from 'vitest'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'

describe('buildRuntimeWorktreePsSummaries', () => {
  it('preserves persisted host ownership over the resolved row fallback', () => {
    const worktree = {
      id: 'repo-1::/workspace/app',
      repoId: 'repo-1',
      hostId: 'ssh:resolved-host',
      path: '/workspace/app',
      branch: 'feature',
      isArchived: false,
      isMainWorktree: false,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      lastActivityAt: 0
    } as unknown as ResolvedWorktree
    const store = {
      getRepos: () => [],
      getWorktreeMeta: () => ({ hostId: 'ssh:persisted-host' }),
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [],
      getProjectGroups: () => []
    } as unknown as RuntimeStore

    const summary = buildRuntimeWorktreePsSummaries({
      store,
      resolvedWorktrees: [worktree],
      platformByRepoId: new Map()
    }).get(worktree.id)

    expect(summary?.hostId).toBe('ssh:persisted-host')
  })
})
