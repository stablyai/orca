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

  it('publishes the resolved host row tags, not the legacy id-keyed record of another host', () => {
    const resolved = (id: string, tags?: string[]) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only these ResolvedWorktree fields.
      ({
        id,
        repoId: 'repo-1',
        hostId: 'ssh:remote',
        path: id.split('::')[1],
        branch: 'feature',
        isArchived: false,
        isMainWorktree: false,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        lastActivityAt: 0,
        ...(tags ? { tags } : {})
      }) as unknown as ResolvedWorktree
    const tagged = resolved('repo-1::/workspace/tagged', ['remote'])
    const plain = resolved('repo-1::/workspace/plain')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder calls only these RuntimeStore members.
    const store = {
      getRepos: () => [],
      // The legacy record belongs to the local host that shares these ids.
      getWorktreeMeta: () => ({ tags: ['local'] }),
      getWorktreeMetaForHost: () => undefined,
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [],
      getProjectGroups: () => []
    } as unknown as RuntimeStore

    const summaries = buildRuntimeWorktreePsSummaries({
      store,
      resolvedWorktrees: [tagged, plain],
      platformByRepoId: new Map()
    })

    expect(summaries.get(tagged.id)?.tags).toEqual(['remote'])
    expect(summaries.get(plain.id)).not.toHaveProperty('tags')
  })
})
