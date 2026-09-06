import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import type { RuntimeStore } from './runtime-store-contract'

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

function queries(
  store: RuntimeStore,
  overrides: Partial<ConstructorParameters<typeof RuntimeManagedWorktreeQueries>[0]> = {}
): RuntimeManagedWorktreeQueries {
  return new RuntimeManagedWorktreeQueries({
    getStore: () => store,
    listResolved: async () => [],
    resolveRepo: async () => store.getRepos()[0]!,
    selectRepos: () => store.getRepos(),
    scanRepo: async () => ({ ok: true, worktrees: [] }),
    listKnownHostIds: () => [],
    ...overrides
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

describe('RuntimeManagedWorktreeQueries.list host scope', () => {
  // Measured on hardware before this fix, same runtime and same refusing SSH host in the same
  // second: the UNSCOPED listing reported `omittedHostIds: ["local","ssh:ssh-scope-refused"]` with
  // `--host` selectors, while the SCOPED listing reported `{"hostIds":[],"omittedHostIds":[]}`.
  // A listing that covered nothing, reporting no gaps, is indistinguishable from a repo that
  // genuinely has no worktrees -- the thing docs/reference/ssh-execution-boundary.md forbids.
  function sshStore(): RuntimeStore {
    const repo = folderRepo({
      id: 'repo-ssh',
      kind: 'git',
      connectionId: 'conn-1',
      path: '/home/dev/app'
    })
    return {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore
  }

  it('names the scoped repo host as omitted when the listing covered nothing', async () => {
    const result = await queries(sshStore()).list('repo-ssh', 50)

    expect(result.totalCount).toBe(0)
    expect(result.hostScope).toEqual({
      hostIds: [],
      omittedHostIds: ['ssh:conn-1']
    })
  })

  it('does not report the scoped host as omitted once it contributes rows', async () => {
    const store = sshStore()
    const result = await queries(store, {
      listResolved: async () =>
        [
          {
            id: 'repo-ssh::/home/dev/app',
            repoId: 'repo-ssh',
            path: '/home/dev/app',
            hostId: 'ssh:conn-1'
          }
        ] as never
    }).list('repo-ssh', 50)

    expect(result.hostScope?.hostIds).toEqual(['ssh:conn-1'])
    expect(result.hostScope?.omittedHostIds).toEqual([])
  })

  // The caller scoped the listing, so the hosts they excluded must not come back as gaps.
  it('never names a host the caller scoped out', async () => {
    const scoped = await queries(sshStore(), {
      listKnownHostIds: () => ['local', 'ssh:other', 'runtime:elsewhere'] as never
    }).list('repo-ssh', 50)

    expect(scoped.hostScope?.omittedHostIds).toEqual(['ssh:conn-1'])
  })

  // `getRepoExecutionHostId` derives the host from two spellings, and a scoped listing that named
  // the wrong one would be worse than naming none. These pin both.
  it('names the local host for a scoped local repo', async () => {
    const repo = folderRepo({ id: 'repo-local', kind: 'git', path: '/workspace/local' })
    const store = {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore

    const result = await queries(store).list('repo-local', 50)

    expect(result.hostScope?.omittedHostIds).toEqual(['local'])
  })

  it('prefers executionHostId over connectionId for the scoped host', async () => {
    const repo = folderRepo({
      id: 'repo-runtime',
      kind: 'git',
      connectionId: 'conn-legacy',
      executionHostId: 'runtime:env-1',
      path: '/workspace/runtime'
    })
    const store = {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore

    const result = await queries(store).list('repo-runtime', 50)

    expect(result.hostScope?.omittedHostIds).toEqual(['runtime:env-1'])
  })

  it('still reports every configured host when the listing is unscoped', async () => {
    const unscoped = await queries(sshStore(), {
      listKnownHostIds: () => ['local', 'ssh:conn-1'] as never
    }).list(undefined, 50)

    expect(unscoped.hostScope?.omittedHostIds).toEqual(['local', 'ssh:conn-1'])
  })
})
