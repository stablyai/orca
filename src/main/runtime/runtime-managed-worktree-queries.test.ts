import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

const settings = {
  workspaceDir: '/worktrees',
  nestWorkspaces: true,
  refreshLocalBaseRefOnWorktreeCreate: false,
  branchPrefix: 'none',
  branchPrefixCustom: ''
}

function folderRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/app',
    displayName: 'Local app',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'folder',
    ...overrides
  }
}

function metadata(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
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
    ...overrides
  }
}

function resolvedWorktree(overrides: Partial<ResolvedWorktree> = {}): ResolvedWorktree {
  const path = overrides.path ?? '/workspace/app'
  return {
    id: `repo-1::${path}`,
    repoId: 'repo-1',
    path,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'Local app',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: {
      path,
      head: 'abc123',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true
    },
    ...overrides
  }
}

function queries(
  store: RuntimeStore,
  resolved: ResolvedWorktree[] = []
): RuntimeManagedWorktreeQueries {
  return new RuntimeManagedWorktreeQueries({
    getStore: () => store,
    listResolved: async () => resolved,
    resolveRepo: async () => store.getRepos()[0]!,
    selectRepos: () => store.getRepos(),
    scanRepo: async () => ({ ok: true, worktrees: [] })
  })
}

describe('RuntimeManagedWorktreeQueries.listDetected', () => {
  it("does not project another host's folder metadata", async () => {
    const local = folderRepo()
    const remote = folderRepo({ connectionId: 'build-box', displayName: 'Remote app' })
    const rootId = `${local.id}::${local.path}`
    const foreignMeta = metadata({ displayName: 'Wrong host', hostId: 'ssh:build-box' })
    const store = {
      getRepos: () => [local, remote],
      getRepo: () => local,
      getAllWorktreeMeta: () => ({ [rootId]: foreignMeta }),
      getWorktreeMeta: () => foreignMeta,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore

    const result = await queries(store).listDetected(local)

    expect(result.worktrees).toHaveLength(1)
    expect(result.worktrees[0]).toMatchObject({
      id: rootId,
      hostId: 'local',
      displayName: 'Local app'
    })
  })

  it('omits host-owned source defaults for clients that do not support them', async () => {
    const repo = folderRepo({ path: '/source/app' })
    const store = {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn((_id, updates) => metadata(updates)),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => ({
        ...settings,
        worktreeVisibilityDefaults: {
          external: 'show' as const,
          customSources: [{ id: 'host-source', rootPath: '/source' }],
          sourcePreferences: { custom: { 'host-source': 'show' as const } }
        }
      })
    } as unknown as RuntimeStore

    const current = await queries(store).listDetected(repo, true)
    const legacy = await queries(store).listDetected(repo, false)

    expect(current.worktrees[0]).toMatchObject({
      visibilitySource: { kind: 'custom', id: 'host-source' }
    })
    expect(legacy.worktrees[0]).not.toHaveProperty('visibilitySource')
  })
})

describe('RuntimeManagedWorktreeQueries.list', () => {
  it('keeps the first visible row from each host before filling the limit', async () => {
    const local = folderRepo()
    const ssh = folderRepo({ id: 'repo-ssh', connectionId: 'box-1', path: '/remote/app' })
    const store = {
      getRepos: () => [local, ssh],
      getRepo: (id: string) => [local, ssh].find((repo) => repo.id === id),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      getSettings: () => settings
    } as unknown as RuntimeStore
    const rows = [
      resolvedWorktree({ hostId: 'local', path: '/workspace/local-1' }),
      resolvedWorktree({
        id: 'repo-ssh::/remote/app',
        repoId: 'repo-ssh',
        path: '/remote/app',
        hostId: 'ssh:box-1'
      }),
      resolvedWorktree({ hostId: 'local', path: '/workspace/local-2' })
    ]

    const result = await queries(store, rows).list(undefined, 2)

    expect(result.worktrees.map((worktree) => worktree.path)).toEqual([
      '/workspace/local-1',
      '/remote/app'
    ])
    expect(result.totalCount).toBe(3)
    expect(result.truncated).toBe(true)

    const complete = await queries(store, rows).list(undefined, 3)

    expect(complete.worktrees.map((worktree) => worktree.path)).toEqual([
      '/workspace/local-1',
      '/remote/app',
      '/workspace/local-2'
    ])
    expect(complete.totalCount).toBe(3)
    expect(complete.truncated).toBe(false)
  })
})
