import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence/loading-store/store'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import { buildDetectedGitWorktrees } from './worktrees/listing/ssh-worktree-fallback'
import {
  resolveRepoWorktreeRows,
  type RepoWorktreeRowDeps
} from '../runtime/repo-worktree-row-resolution'
import { pruneMetadataMissingFromAuthoritativeLocalScan } from './worktrees/listing/authoritative-local-worktree-metadata-pruning'
import { loggedSharedGitCommonDirWarnings } from './worktrees/listing/worktree-listing-diagnostics'
import { getLocalWorktreeScanGeneration } from '../local-worktree-scan-generation'

import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import {
  captureNativeLocalWorktreeMetadataScanExpectation,
  pruneSessionlessMissingLocalWorktreeMetadataForRepo,
  selectProbeableLocalWorktreeMetadataCandidates,
  type NativeLocalWorktreeMetadataScanExpectation
} from '../persistence/tracking-repos/missing-local-worktree-metadata-pruning'

function createTestRepo(
  id: string,
  path: string,
  options: { connectionId?: string; executionHostId?: string } = {}
): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test mock repo fixture.
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test mock executionHostId fixture.
    ...(options.executionHostId
      ? { executionHostId: options.executionHostId as Repo['executionHostId'] }
      : {})
  } as Repo
}

function createTestSetup(
  id: string,
  projectId: string,
  hostId: string,
  repoId: string,
  path: string
): ProjectHostSetup {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test mock setup fixture.
  return {
    id,
    projectId,
    hostId,
    repoId,
    path
  } as ProjectHostSetup
}

function createGitWorktree(path: string, options: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path,
    head: 'refs/heads/main',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    ...options
  }
}

describe('cross-host shared .git worktree handling (issue #21764)', () => {
  const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  beforeEach(() => {
    loggedSharedGitCommonDirWarnings.clear()
    consoleWarnSpy.mockClear()
  })

  function createMockStore(
    repos: Repo[],
    setups: ProjectHostSetup[] = [],
    platform: NodeJS.Platform = 'linux'
  ): Store & {
    meta: Record<string, WorktreeMeta>
    prunedIds: string[]
    lineage: Record<string, WorktreeLineage>
  } {
    const state = getDefaultPersistedState('/mock/home')
    state.repos = [...repos]
    const meta: Record<string, WorktreeMeta> = state.worktreeMeta
    const prunedIds: string[] = []
    const lineage: Record<string, WorktreeLineage> = {}
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Partial store mock for worktree lifecycle tests.
    const store = {
      meta,
      prunedIds,
      lineage,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((r) => r.id === id),
      getProjects: () => [],
      getProjectHostSetups: () => setups,
      getSettings: () => ({ worktreeVisibilityDefaults: { showHiddenWorktrees: false } }),
      getAllWorktreeMeta: () => meta,
      getAllWorktreeMetaForHost: () => meta,
      getWorktreeMetaForHost: (id: string) => meta[id],
      getAllWorktreeLineage: () => lineage,
      removeWorktreeLineage: vi.fn((id: string) => {
        delete lineage[id]
      }),
      getWorktreeMeta: (id: string) => meta[id],
      setWorktreeMeta: vi.fn((id: string, updates: Partial<WorktreeMeta>) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: In-memory store fixture mutation.
        meta[id] = { ...meta[id], ...updates } as WorktreeMeta
        return meta[id]
      }),
      setWorktreeMetaForHost: vi.fn(
        (id: string, hostId: string, updates: Partial<WorktreeMeta>) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: In-memory store fixture mutation.
          meta[id] = { ...meta[id], ...updates, hostId } as WorktreeMeta
          return meta[id]
        }
      ),
      captureNativeLocalWorktreeMetadataScanExpectation: (repo: Repo) =>
        captureNativeLocalWorktreeMetadataScanExpectation(state, repo),
      selectProbeableLocalWorktreeMetadataCandidates: (
        scan: NativeLocalWorktreeMetadataScanExpectation
      ) => selectProbeableLocalWorktreeMetadataCandidates(state, scan, platform),
      pruneSessionlessMissingLocalWorktreeMetadataForRepo: vi.fn((scan, missing) => {
        const removed = pruneSessionlessMissingLocalWorktreeMetadataForRepo(
          state,
          scan,
          missing,
          platform
        )
        prunedIds.push(...removed)
        return removed
      }),
      getProfileStorageDirectory: () => '/mock/profiles'
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Typed mock store cast.
    } as unknown as Store & {
      meta: Record<string, WorktreeMeta>
      prunedIds: string[]
      lineage: Record<string, WorktreeLineage>
      state: PersistedState
    }

    return store
  }

  describe('Windows execution host encountering Linux container worktrees', () => {
    const windowsRepo = createTestRepo('repo-win', 'C:/Users/alice/project')
    const linuxRepo = createTestRepo('repo-linux', '/workspaces/project', {
      connectionId: 'dev-container',
      executionHostId: 'ssh:dev-container'
    })

    const setups: ProjectHostSetup[] = [
      createTestSetup('s-win', 'p-shared', 'local', 'repo-win', 'C:/Users/alice/project'),
      createTestSetup(
        's-linux',
        'p-shared',
        'ssh:dev-container',
        'repo-linux',
        '/workspaces/project'
      )
    ]

    const scannedGitWorktrees: GitWorktreeInfo[] = [
      createGitWorktree('C:/Users/alice/project', { isMainWorktree: true }),
      createGitWorktree('C:/Users/alice/project/feat-win', { branch: 'refs/heads/feat-win' }),
      createGitWorktree('/workspaces/project/seacucumber', {
        prunable: true,
        prunableReason: 'gitdir file points to non-existent location'
      })
    ]

    it('buildDetectedGitWorktrees omits prunable and foreign POSIX worktrees on Windows', () => {
      const store = createMockStore([windowsRepo, linuxRepo], setups)
      const detected = buildDetectedGitWorktrees(store, windowsRepo, scannedGitWorktrees)

      expect(detected.map((w) => w.path)).toEqual([
        'C:/Users/alice/project',
        'C:/Users/alice/project/feat-win'
      ])
      expect(detected.some((w) => w.path.includes('seacucumber'))).toBe(false)
      expect(store.meta['repo-win::/workspaces/project/seacucumber']).toBeUndefined()
    })

    it('resolveRepoWorktreeRows does not register foreign POSIX worktrees in worktreeMeta and emits shared .git warning', async () => {
      const store = createMockStore([windowsRepo, linuxRepo], setups)
      const deps: RepoWorktreeRowDeps = {
        store,
        scanRepo: vi.fn(async () => ({ ok: true, worktrees: scannedGitWorktrees })),
        listFolderWorkspaces: vi.fn(() => [])
      }

      const rows = await resolveRepoWorktreeRows(deps, windowsRepo, store.meta, new Map())

      expect(rows.map((r) => r.git.path)).toEqual([
        'C:/Users/alice/project',
        'C:/Users/alice/project/feat-win'
      ])
      expect(store.setWorktreeMetaForHost).not.toHaveBeenCalledWith(
        expect.stringContaining('seacucumber'),
        expect.anything(),
        expect.anything()
      )
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "these hosts share one .git; git worktree prune on either host will drop the other's worktrees"
        )
      )
    })

    it('pruneMetadataMissingFromAuthoritativeLocalScan hides but never purges legacy phantom metadata', async () => {
      const store = createMockStore([windowsRepo, linuxRepo], setups, 'win32')
      const phantomId = 'repo-win::/workspaces/project/seacucumber'
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test mock meta fixture.
      store.meta[phantomId] = {
        hostId: 'local',
        createdAt: 1000,
        lastActivityAt: 1000
      } as WorktreeMeta

      const expectation = store.captureNativeLocalWorktreeMetadataScanExpectation(windowsRepo)
      const pruneResult = await pruneMetadataMissingFromAuthoritativeLocalScan({
        store,
        repo: windowsRepo,
        gitWorktrees: scannedGitWorktrees,
        scan: expectation!,
        scanGeneration: getLocalWorktreeScanGeneration(windowsRepo.id),
        platform: 'win32',
        pathsExistOrAreUnverifiable: async () =>
          new Map([['/workspaces/project/seacucumber', false]])
      })

      expect(pruneResult.removedWorktreeIds).not.toContain(phantomId)
      expect(store.meta[phantomId]).toBeDefined()
    })
  })

  describe('local Linux host sharing .git with a Windows host', () => {
    it('pruneMetadataMissingFromAuthoritativeLocalScan keeps prunable and foreign rows git still lists', async () => {
      const localLinuxRepo = createTestRepo('repo-local', '/workspaces/project')
      const store = createMockStore([localLinuxRepo], [], 'linux')
      const prunablePath = '/workspaces/project/gone'
      const foreignPath =
        '/workspaces/project/.git/worktrees/28712-abc/C:/Users/alice/project/sockeye'
      const stalePath = '/workspaces/project/stale'
      for (const path of [prunablePath, foreignPath, stalePath]) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test mock meta fixture.
        store.meta[`repo-local::${path}`] = {
          hostId: 'local',
          createdAt: 1000,
          lastActivityAt: 1000
        } as WorktreeMeta
      }

      const expectation = store.captureNativeLocalWorktreeMetadataScanExpectation(localLinuxRepo)
      const pruneResult = await pruneMetadataMissingFromAuthoritativeLocalScan({
        store,
        repo: localLinuxRepo,
        gitWorktrees: [
          createGitWorktree('/workspaces/project', { isMainWorktree: true }),
          createGitWorktree(prunablePath, { prunable: true }),
          createGitWorktree(foreignPath, { prunable: true })
        ],
        scan: expectation!,
        scanGeneration: getLocalWorktreeScanGeneration(localLinuxRepo.id),
        platform: 'linux',
        pathsExistOrAreUnverifiable: async (paths: readonly string[]) =>
          new Map(paths.map((path) => [path, false]))
      })

      // Only the row git no longer lists is pruned; the old prunable filter purged the other two.
      expect(pruneResult.removedWorktreeIds).toEqual([`repo-local::${stalePath}`])
      expect(store.meta[`repo-local::${prunablePath}`]).toBeDefined()
      expect(store.meta[`repo-local::${foreignPath}`]).toBeDefined()
    })
  })

  describe('Linux dev container execution host encountering Windows worktrees', () => {
    const windowsRepo = createTestRepo('repo-win', 'C:/Users/alice/project')
    const linuxRepo = createTestRepo('repo-linux', '/workspaces/project', {
      connectionId: 'dev-container',
      executionHostId: 'ssh:dev-container'
    })

    const setups: ProjectHostSetup[] = [
      createTestSetup('s-win', 'p-shared', 'local', 'repo-win', 'C:/Users/alice/project'),
      createTestSetup(
        's-linux',
        'p-shared',
        'ssh:dev-container',
        'repo-linux',
        '/workspaces/project'
      )
    ]

    const containerGitWorktrees: GitWorktreeInfo[] = [
      createGitWorktree('/workspaces/project', { isMainWorktree: true }),
      createGitWorktree('/workspaces/project/seacucumber', { branch: 'refs/heads/seacucumber' }),
      createGitWorktree(
        '/workspaces/project/.git/worktrees/28712-abc/C:/Users/alice/project/sockeye',
        {
          prunable: true,
          prunableReason: 'gitdir file points to non-existent location'
        }
      )
    ]

    it('buildDetectedGitWorktrees omits prunable and mangled Windows paths on Linux', () => {
      const store = createMockStore([linuxRepo, windowsRepo], setups)
      const detected = buildDetectedGitWorktrees(store, linuxRepo, containerGitWorktrees)

      expect(detected.map((w) => w.path)).toEqual([
        '/workspaces/project',
        '/workspaces/project/seacucumber'
      ])
      expect(detected.some((w) => w.path.includes('sockeye'))).toBe(false)
    })

    it('resolveRepoWorktreeRows omits mangled Windows worktree and does not persist metadata', async () => {
      const store = createMockStore([linuxRepo, windowsRepo], setups)
      const deps: RepoWorktreeRowDeps = {
        store,
        scanRepo: vi.fn(async () => ({ ok: true, worktrees: containerGitWorktrees })),
        listFolderWorkspaces: vi.fn(() => [])
      }

      const rows = await resolveRepoWorktreeRows(deps, linuxRepo, store.meta, new Map())

      expect(rows.map((r) => r.git.path)).toEqual([
        '/workspaces/project',
        '/workspaces/project/seacucumber'
      ])
      expect(store.setWorktreeMetaForHost).not.toHaveBeenCalledWith(
        expect.stringContaining('sockeye'),
        expect.anything(),
        expect.anything()
      )
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "these hosts share one .git; git worktree prune on either host will drop the other's worktrees"
        )
      )
    })

    it('resolveRepoWorktreeRows keeps lineage for prunable and foreign registrations', async () => {
      const store = createMockStore([linuxRepo], setups)
      const prunableId = 'repo-linux::/workspaces/project/gone'
      const foreignId = `repo-linux::${containerGitWorktrees[2]!.path}`
      for (const worktreeId of [prunableId, foreignId]) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the keys pruning reads.
        store.lineage[worktreeId] = {
          worktreeId,
          parentWorktreeId: 'repo-linux::/workspaces/project'
        } as WorktreeLineage
      }
      const deps: RepoWorktreeRowDeps = {
        store,
        scanRepo: vi.fn(async () => ({
          ok: true,
          worktrees: [
            ...containerGitWorktrees,
            createGitWorktree('/workspaces/project/gone', { prunable: true })
          ]
        })),
        listFolderWorkspaces: vi.fn(() => [])
      }

      const rows = await resolveRepoWorktreeRows(deps, linuxRepo, store.meta, new Map())

      expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
      expect(Object.keys(store.lineage)).toEqual([prunableId, foreignId])
      expect(rows.map((r) => r.git.path)).toContain('/workspaces/project/gone')
    })
  })
})
