import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'

const { pruneLineageMock, pruneMetadataMock } = vi.hoisted(() => ({
  pruneLineageMock: vi.fn(),
  pruneMetadataMock: vi
    .fn()
    .mockResolvedValue({ scanGenerationCurrent: true, preservedMetadataCandidateIds: new Set() })
}))
vi.mock('../worktree-lineage-pruning', () => ({
  pruneLineageForMissingRepoWorktrees: pruneLineageMock
}))
vi.mock(
  '../ipc/worktrees/listing/authoritative-local-worktree-metadata-pruning',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    pruneMetadataMissingFromAuthoritativeLocalScan: pruneMetadataMock
  })
)
const { hiddenHostIds } = vi.hoisted(() => ({ hiddenHostIds: new Set<string>() }))
vi.mock('./runtime-visible-catalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runtimeHiddenHostIds: () => hiddenHostIds
}))
vi.mock('../project-runtime-git-options', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLocalProjectWorktreeGitOptions: () => ({})
}))

import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import type { RuntimeStore } from './runtime-store-contract'
import { partialRuntimeStore } from './runtime-store-partial-fixture'
import { getRepoHostIdentityForParts } from '../../shared/repo-host-identity'
import {
  bumpLocalWorktreeScanGeneration,
  getLocalWorktreeScanGeneration,
  resetLocalWorktreeScanGenerationsForTests
} from '../local-worktree-scan-generation'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

const settings: ReturnType<RuntimeStore['getSettings']> = {
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

describe('RuntimeManagedWorktreeQueries.buildVisibilityMatchers', () => {
  it.each([false, true])(
    'keeps host-qualified matcher inputs and defaults (reversed=%s)',
    (reversed) => {
      const local = folderRepo({
        customWorktreeVisibilitySources: [{ id: 'local-source', rootPath: '/local-source' }]
      })
      const remote = folderRepo({
        connectionId: 'builder',
        path: '/remote/app',
        worktreeBasePath: '.claude/worktrees',
        customWorktreeVisibilitySources: [{ id: 'remote-source', rootPath: '/remote-source' }]
      })
      const repos = reversed ? [remote, local] : [local, remote]
      const worktrees = ['/checkout/first', '/checkout/second'].map((path, index) => ({
        ...mergeWorktree(
          local.id,
          { path, head: 'abc', branch: 'topic', isBare: false, isMainWorktree: false },
          undefined
        ),
        hostId: index === 0 ? ('local' as const) : ('ssh:builder' as const)
      }))
      const defaults = { customSources: [{ id: 'default-source', rootPath: '/default-source' }] }
      const catalog = queries(
        partialRuntimeStore({
          getRepos: () => [...repos, folderRepo({ id: 'without-checkout' })],
          getSettings: () => ({ ...settings, worktreeVisibilityDefaults: defaults })
        })
      )
      const matchers = catalog.buildVisibilityMatchers(worktrees)
      expect([...matchers.keys()]).toEqual([
        ...repos.map((repo) =>
          getRepoHostIdentityForParts(repo.id, repo.connectionId ? 'ssh:builder' : 'local')
        ),
        getRepoHostIdentityForParts('without-checkout', 'local')
      ])
      for (const [index, hostId] of (['local', 'ssh:builder'] as const).entries()) {
        const key = getRepoHostIdentityForParts(local.id, hostId)
        const matcher = matchers.get(key)!
        expect(matcher(`${worktrees[index]!.path}/.claude/worktrees/topic`)).toEqual({
          kind: 'built-in',
          id: 'claude'
        })
        expect(matcher(`${worktrees[1 - index]!.path}/.claude/worktrees/topic`)).toBeNull()
        expect(matcher('/local-source/topic')).toEqual(
          index === 0 ? { kind: 'custom', id: 'local-source' } : null
        )
        expect(matcher('/remote-source/topic')).toEqual(
          index === 1 ? { kind: 'custom', id: 'remote-source' } : null
        )
        expect(
          matcher(`${index === 0 ? local.path : remote.path}/.claude/worktrees/topic`)
        ).toEqual(index === 0 ? { kind: 'built-in', id: 'claude' } : null)
        expect(matcher('/default-source/topic')).toEqual({ kind: 'custom', id: 'default-source' })
        expect(
          catalog.buildVisibilityMatchers(worktrees, false).get(key)!('/default-source/topic')
        ).toBeNull()
        expect(
          catalog.buildVisibilityMatchers(worktrees, true, settings).get(key)!(
            '/default-source/topic'
          )
        ).toBeNull()
      }
    }
  )
})

describe('RuntimeManagedWorktreeQueries.listDetected', () => {
  it('stamps a scanned listing with the generation its scan began at', async () => {
    resetLocalWorktreeScanGenerationsForTests()
    const repo = folderRepo({ kind: 'git', path: '/source/git-app' })
    const store = {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore
    const atScanStart = getLocalWorktreeScanGeneration(repo.id)
    const scanRepo = vi.fn(async () => {
      // A mutation lands after the scan settles; the listing still names the catalog it scanned.
      return { ok: true as const, worktrees: [] }
    })

    const listing = await queries(store, { scanRepo }).listDetected(repo)
    bumpLocalWorktreeScanGeneration(repo.id)

    expect(listing.authoritative).toBe(true)
    expect(listing.catalogVersion?.sequence).toBe(atScanStart)
    expect(listing.catalogVersion?.epoch).toEqual(expect.any(String))
    expect(getLocalWorktreeScanGeneration(repo.id)).toBeGreaterThan(atScanStart)
  })

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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial store mock; the code under test reads only the members it defines.
    const store = {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn((_target: HostWorktreeTarget, updates) => metadata(updates)),
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
  it('uses the resolved legacy host matcher and omits ambiguous legacy rows', async () => {
    const repo = folderRepo({
      kind: 'git',
      connectionId: 'builder',
      customWorktreeVisibilitySources: [{ id: 'remote-source', rootPath: '/source' }],
      worktreeVisibilitySourcePreferences: { custom: { 'remote-source': 'hide' } }
    })
    const git: GitWorktreeInfo = {
      path: '/source/topic',
      head: '',
      branch: 'topic',
      isBare: false,
      isMainWorktree: false
    }
    const row: ResolvedWorktree = {
      ...mergeWorktree(repo.id, git, undefined),
      git,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    }
    let repos = [repo]
    let rows = [row]
    const listing = queries(
      partialRuntimeStore({ getRepos: () => repos, getSettings: () => settings }),
      {
        listResolved: async () => rows
      }
    )
    expect((await listing.list(undefined, 10)).worktrees).toEqual([])
    repos = [repo, folderRepo({ kind: 'git' })]
    expect((await listing.list(undefined, 10)).worktrees).toEqual([])
    rows = [
      { ...row, hostId: 'ssh:builder' },
      { ...row, hostId: 'local' }
    ]
    expect((await listing.list('remote', 10)).worktrees).toEqual([])
  })

  it.each([5, 50])('bounds listing hydration and ownership work at scale %s', async (size) => {
    let idReads = 0
    let hydrated = 0
    const local = folderRepo({ kind: 'git', externalWorktreeVisibility: 'hide' })
    const ssh = folderRepo({
      kind: 'git',
      connectionId: 'builder',
      externalWorktreeVisibility: 'show'
    })
    const repos = [
      local,
      ssh,
      ...Array.from({ length: size }, (_, index) => folderRepo({ id: `unrelated-${index}` }))
    ]
    const getRepos = vi.fn(() =>
      repos.map((repo) => {
        hydrated++
        return {
          ...repo,
          get id() {
            idReads++
            return repo.id
          }
        }
      })
    )
    const rows: ResolvedWorktree[] = [local, ssh].flatMap((repo) =>
      Array.from({ length: size }, (_, index) => {
        const git: GitWorktreeInfo = {
          path: index === 0 ? repo.path : `/outside/work-${index}`,
          head: 'abc',
          branch: `branch-${index}`,
          isBare: false,
          isMainWorktree: index === 0
        }
        return {
          ...mergeWorktree(repo.id, git, undefined),
          hostId: repo.connectionId ? ('ssh:builder' as const) : ('local' as const),
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null,
          git
        }
      })
    )
    const store: RuntimeStore = {
      getRepo: vi.fn<RuntimeStore['getRepo']>(),
      addRepo: vi.fn<RuntimeStore['addRepo']>(),
      updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
      setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
      removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
      getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
      getRepos,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      getSettings: () => settings
    }
    const listing = queries(store, {
      listResolved: async () => rows,
      listKnownHostIds: () => ['local', 'ssh:builder']
    })

    const page = await listing.list(undefined, 2)

    expect(page.totalCount).toBe(size + 1)
    expect(page.truncated).toBe(true)
    expect(page.worktrees.map((row) => row.hostId)).toEqual(['local', 'ssh:builder'])
    expect(getRepos.mock.calls.length).toBeLessThanOrEqual(3)
    expect(hydrated).toBeLessThanOrEqual(3 * repos.length)
    expect(idReads).toBeLessThanOrEqual(20 * (repos.length + rows.length))
  })

  it.each([false, true])(
    'preserves host twins, expandable coverage and per-host visibility (reversed=%s)',
    async (reversed) => {
      const local = folderRepo({ kind: 'git', externalWorktreeVisibility: 'hide' })
      const ssh = folderRepo({
        kind: 'git',
        connectionId: 'builder',
        externalWorktreeVisibility: 'show'
      })
      const repos = reversed ? [ssh, local] : [local, ssh]
      const rows: ResolvedWorktree[] = [local, ssh].flatMap((repo) =>
        Array.from({ length: 202 }, (_, index) => {
          const git: GitWorktreeInfo = {
            path: index === 0 ? repo.path : `/outside/work-${index}`,
            head: 'abc',
            branch: `branch-${index}`,
            isBare: false,
            isMainWorktree: index === 0
          }
          return {
            ...mergeWorktree(repo.id, git, undefined),
            hostId: repo.connectionId ? ('ssh:builder' as const) : ('local' as const),
            parentWorktreeId: null,
            childWorktreeIds: [],
            lineage: null,
            git
          }
        })
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: list only reads this store surface.
      const store = {
        getRepos: () => repos,
        getRepo: () => repos[0],
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        getSettings: () => settings
      } as unknown as RuntimeStore
      const catalog = queries(store, {
        listResolved: async () => rows,
        listKnownHostIds: () => ['local', 'ssh:builder']
      })
      const first = await catalog.list(undefined, 200)
      expect(first).toMatchObject({
        totalCount: 203,
        truncated: true,
        hostScope: { hostIds: ['local', 'ssh:builder'], omittedHostIds: [] }
      })
      const complete = await catalog.list(undefined, first.totalCount)
      expect(complete.truncated).toBe(false)
      expect(
        complete.worktrees
          .filter((row) => row.id === `${local.id}::${local.path}`)
          .map((row) => row.hostId)
          .sort()
      ).toEqual(['local', 'ssh:builder'])
      expect(complete.worktrees.filter((row) => row.hostId === 'local')).toHaveLength(1)
      expect(
        complete.worktrees.some(
          (row) => row.path === '/outside/work-201' && row.hostId === 'ssh:builder'
        )
      ).toBe(true)
    }
  )

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

  // A selector still resolves a converted host's retained repo; its host must not leak back out.
  it('never names a hidden host, even for a selector that resolves to its repo', async () => {
    hiddenHostIds.add('ssh:conn-1')
    try {
      const result = await queries(sshStore()).list('repo-ssh', 50)
      expect(result.hostScope?.omittedHostIds).toEqual([])
    } finally {
      hiddenHostIds.clear()
    }
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

  // Check both host spellings so scoped coverage names the actual execution host.
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

describe('RuntimeManagedWorktreeQueries.listDetected overtaken scan', () => {
  const repo = folderRepo({ kind: 'git' })
  const created = '/worktrees/created'

  function rows(paths: readonly string[]): GitWorktreeInfo[] {
    return paths.map((path) => ({
      path,
      head: 'abc',
      branch: 'main',
      isBare: false,
      isMainWorktree: path === repo.path
    }))
  }

  function gitStore(overrides: Record<string, unknown> = {}): RuntimeStore {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the git listing reads only these store members; the prunes that would need more are mocked above.
    return {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings,
      ...overrides
    } as unknown as RuntimeStore
  }

  /** A scan a worktree change lands under: the generation moves before the rows come back. */
  function overtakenScan(paths: readonly string[]) {
    return async () => {
      bumpLocalWorktreeScanGeneration(repo.id)
      return { ok: true as const, worktrees: rows(paths) }
    }
  }

  beforeEach(() => {
    resetLocalWorktreeScanGenerationsForTests()
    pruneLineageMock.mockClear()
    pruneMetadataMock.mockClear()
  })

  it('re-runs a scan a worktree change overtook and publishes the second scan as authoritative', async () => {
    const scanRepo = vi
      .fn()
      .mockImplementationOnce(overtakenScan([repo.path]))
      .mockResolvedValueOnce({ ok: true, worktrees: rows([repo.path, created]) })

    const result = await queries(gitStore(), { scanRepo }).listDetected(repo)

    expect(scanRepo).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ authoritative: true, source: 'git' })
    expect(result.worktrees.map((worktree) => worktree.path)).toEqual([repo.path, created])
    // The overtaken rows omit the created worktree; only the settled rows may prune.
    expect(pruneLineageMock).toHaveBeenCalledTimes(1)
    expect(pruneLineageMock.mock.calls[0]?.[2]).toEqual(rows([repo.path, created]))
  })

  it('prunes metadata against the expectation and generation of the scan it publishes', async () => {
    const expectations: unknown[] = []
    const generations: number[] = []
    const store = gitStore({
      pruneSessionlessMissingLocalWorktreeMetadataForRepo: vi.fn(() => []),
      getProfileStorageDirectory: () => '/profile',
      captureNativeLocalWorktreeMetadataScanExpectation: vi.fn(() => {
        const expectation = { repo, metadata: [] }
        expectations.push(expectation)
        generations.push(getLocalWorktreeScanGeneration(repo.id))
        return expectation
      })
    })
    const scanRepo = vi
      .fn()
      .mockImplementationOnce(overtakenScan([repo.path]))
      .mockResolvedValueOnce({ ok: true, worktrees: rows([repo.path, created]) })

    await queries(store, { scanRepo }).listDetected(repo)

    expect(expectations).toHaveLength(2)
    expect(pruneMetadataMock).toHaveBeenCalledTimes(1)
    expect(pruneMetadataMock.mock.calls[0]?.[0]).toMatchObject({
      scan: expectations[1],
      scanGeneration: generations[1],
      gitWorktrees: rows([repo.path, created])
    })
  })

  it('publishes the last scan non-authoritatively once the re-scan bound is spent', async () => {
    const scanRepo = vi.fn(overtakenScan([repo.path]))

    const result = await queries(gitStore(), { scanRepo }).listDetected(repo)

    // One scan plus the two re-runs the bound allows.
    expect(scanRepo).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ authoritative: false, source: 'git' })
    expect(result.unavailableReason).toBeUndefined()
    expect(result.failureKind).toBeUndefined()
    expect(result.worktrees.map((worktree) => worktree.path)).toEqual([repo.path])
    expect(pruneLineageMock).not.toHaveBeenCalled()
    expect(pruneMetadataMock).not.toHaveBeenCalled()
  })

  it('does not re-run a failed scan the change overtook', async () => {
    const scanRepo = vi.fn(async () => {
      bumpLocalWorktreeScanGeneration(repo.id)
      return { ok: false as const, worktrees: [] }
    })

    const result = await queries(gitStore(), { scanRepo }).listDetected(repo)

    expect(scanRepo).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ authoritative: false, source: 'metadata-fallback' })
  })
})
