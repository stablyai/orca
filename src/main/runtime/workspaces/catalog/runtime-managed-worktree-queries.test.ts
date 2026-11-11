import { mergeWorktree } from '../../../ipc/worktree-metadata-merge'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'

const { pruneLineageMock, pruneMetadataMock } = vi.hoisted(() => ({
  pruneLineageMock: vi.fn(),
  pruneMetadataMock: vi
    .fn()
    .mockResolvedValue({ scanGenerationCurrent: true, preservedMetadataCandidateIds: new Set() })
}))
vi.mock('../../../workspaces/catalog/worktree-lineage-pruning', () => ({
  pruneLineageForMissingRepoWorktrees: pruneLineageMock
}))
vi.mock(
  '../../../ipc/worktrees/listing/authoritative-local-worktree-metadata-pruning',
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
vi.mock(
  '../../../workspaces/execution-host/project-runtime-git-options',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getLocalProjectWorktreeGitOptions: () => ({})
  })
)

import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import {
  bumpLocalWorktreeScanGeneration,
  resetLocalWorktreeScanGenerationsForTests
} from '../../../workspaces/catalog/local-worktree-scan-generation'

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
})

describe('RuntimeManagedWorktreeQueries.list host scope', () => {
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
})
