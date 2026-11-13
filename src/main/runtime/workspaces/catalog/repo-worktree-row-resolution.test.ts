import { getHiddenImportableExternalWorktrees } from '../../../../shared/external-worktree-inbox'
import { buildValidWorktreeIdsForSessionHydration } from '../../../../shared/worktree/catalog/degraded-repo-worktree-validity'
import { applyMetadataFallbackVisibility } from '../../../../shared/worktree/visibility/ownership'
import {
  joinResolvedWorktreeScans,
  type ResolvedWorktreeRepoScans
} from './resolved-worktree-scan-join'
import { describe, expect, it, vi } from 'vitest'

import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

import type { GitWorktreeInfo, Worktree } from '../../../../shared/worktree/types'
import { mergeWorktreeMetaForWrite } from '../../../persistence/loading-store/worktree-metadata/worktree-meta-write-normalization'
import { buildDetectedGitWorktrees } from '../../../ipc/worktrees/listing/ssh-worktree-fallback'
import {
  projectRepoWorktreeRows,
  resolveRepoWorktreeRows,
  resolveScopedWorktreeIdRow,
  scanRepoWorktreeRows,
  type RepoWorktreeRowDeps
} from './repo-worktree-row-resolution'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { scanRuntimeWorktreesUntilNotOvertaken } from './runtime-witnessed-worktree-scan'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import {
  partialRuntimeStore,
  storeWorktreeMeta
} from '../../orca-runtime-tests/runtime-store-partial-fixture'
import {
  pendingWorktreeRemovals,
  recordedWorktreeRemovals,
  finishedWorktreeRemovals
} from '../../../workspaces/removal/worktree-removal-table'
import { bumpLocalWorktreeScanGeneration } from '../../../workspaces/catalog/local-worktree-scan-generation'

function repo(
  id: string,
  path: string,
  options: Pick<Repo, 'connectionId' | 'executionHostId' | 'kind'> = {}
): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: 'blue',
    addedAt: 1,
    ...options
  }
}

function gitWorktree(path: string): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false
  }
}

function createDeps(repos: Repo[]): RepoWorktreeRowDeps & {
  store: RuntimeStore
  metaById: Record<string, WorktreeMeta>
  rawScanRepo: ReturnType<typeof vi.fn<(owner: Repo) => Promise<RuntimeWorktreeScanResult>>>
  listFolderWorkspaces: ReturnType<typeof vi.fn<RepoWorktreeRowDeps['listFolderWorkspaces']>>
} {
  const metaById: Record<string, WorktreeMeta> = {}
  const store = partialRuntimeStore({
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getAllWorktreeLineage: () => ({}),
    getProjects: () => [],
    getSettings: () => ({}),
    setWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
      const next = storeWorktreeMeta({ ...metaById[worktreeId], ...updates })
      metaById[worktreeId] = next
      return next
    }
  })
  const rawScanRepo = vi.fn<(owner: Repo) => Promise<RuntimeWorktreeScanResult>>(async (owner) => ({
    ok: true,
    worktrees: [gitWorktree(owner.id === 'unrelated' ? '/unrelated/worktree' : '/same/worktree')]
  }))
  const listFolderWorkspaces = vi.fn<RepoWorktreeRowDeps['listFolderWorkspaces']>(() => [])
  return {
    store,
    metaById,
    rawScanRepo,
    scanRepo: (owner) => scanRuntimeWorktreesUntilNotOvertaken(store, owner, rawScanRepo),
    listFolderWorkspaces
  }
}

describe('host-qualified scoped worktree resolution', () => {
  it('projects current saved rows without stamping or marking a fleet scan accepted after it is overtaken', async () => {
    const owner = repo('late-fleet', '/repo')
    const deps = createDeps([owner])
    const savedId = `${owner.id}::/repo/saved`
    deps.store.setWorktreeMeta(hostWorktreeTarget({ id: savedId, hostId: 'local' }), {
      comment: 'saved content',
      hostId: 'local',
      gitWorktree: { isBare: false, isMainWorktree: false, branch: 'saved', prunable: false }
    })
    deps.rawScanRepo.mockResolvedValue({ ok: true, worktrees: [gitWorktree('/repo/new')] })
    const scan = await scanRepoWorktreeRows(deps, owner, new Map())
    bumpLocalWorktreeScanGeneration(owner.id)
    const before = structuredClone(deps.metaById)
    const joined = joinResolvedWorktreeScans(
      deps.store,
      () => deps,
      new Map([[getRepoHostIdentityForParts(owner.id, 'local'), { ...scan, gitRun: {} }]])
    )
    expect(joined.worktrees.map((row) => row.path)).toEqual(['/repo/saved'])
    expect(joined.scannedRepoKeys.size).toBe(0)
    expect(joined.gitRunById.size).toBe(0)
    expect(deps.metaById).toEqual(before)
  })
  it('does not project another host metadata onto a colliding scoped row', async () => {
    const deps = createDeps([
      repo('shared', '/local/repo', { executionHostId: 'local' }),
      repo('shared', '/remote/repo', {
        connectionId: 'builder',
        executionHostId: 'ssh:builder'
      })
    ])
    const worktreeId = 'shared::/same/worktree'
    deps.metaById[worktreeId] = {
      displayName: 'local workspace',
      hostId: 'local',
      instanceId: 'local-instance',
      preserveBranchOnDelete: true
    } as WorktreeMeta

    await expect(
      resolveScopedWorktreeIdRow(deps, worktreeId, 'ssh:builder')
    ).resolves.toMatchObject({
      id: worktreeId,
      hostId: 'ssh:builder',
      displayName: 'feature'
    })
  })

  it('resolves only the selected folder-workspace owner without scanning Git providers', async () => {
    const local = repo('folders', '/local/folders', {
      kind: 'folder',
      executionHostId: 'local'
    })
    const remote = repo('folders', '/remote/folders', {
      kind: 'folder',
      connectionId: 'builder',
      executionHostId: 'ssh:builder'
    })
    const deps = createDeps([local, remote, repo('unrelated', '/unrelated/repo')])
    const worktreeId = 'folders::/shared/folder'
    deps.listFolderWorkspaces.mockImplementation((owner) =>
      owner.id === remote.id && owner.executionHostId === remote.executionHostId
        ? ([
            {
              id: worktreeId,
              repoId: owner.id,
              path: '/shared/folder',
              head: '',
              branch: '',
              isBare: false,
              isMainWorktree: false,
              displayName: 'folder',
              comment: '',
              hostId: 'ssh:builder'
            } as unknown as Worktree
          ] as Worktree[])
        : []
    )

    await expect(
      resolveScopedWorktreeIdRow(deps, worktreeId, 'ssh:builder')
    ).resolves.toMatchObject({ id: worktreeId, hostId: 'ssh:builder' })
    expect(deps.listFolderWorkspaces).toHaveBeenCalledExactlyOnceWith(remote, 2)
    expect(deps.rawScanRepo).not.toHaveBeenCalled()
  })
})

/** Normalize id-selector paths like path selectors so UI removal resolves the same host-qualified row as CLI (#16243). */
describe('scoped worktree id resolution across path spellings (#16243)', () => {
  it('refuses rather than guessing when two rows spell one path', async () => {
    const owner = repo('shared', '/local/repo', { executionHostId: 'local' })
    const deps = createDeps([owner])
    deps.rawScanRepo.mockImplementation(async () => ({
      ok: true,
      worktrees: [gitWorktree('/same/worktree'), gitWorktree('/same//worktree')]
    }))

    await expect(
      resolveScopedWorktreeIdRow(deps, 'shared::/same/worktree/', 'local')
    ).resolves.toBeNull()
  })

  // #15598/#15616: the backslash spelling is what a pre-restart Windows registration recorded.
  it('resolves a Windows backslash id against the forward-slash spelling git reports', async () => {
    const path = 'D:/Agentic/game2/battle-core'
    const owner = repo('shared', 'D:/Agentic/game2', { executionHostId: 'runtime:windows' })
    const deps = createDeps([owner])
    deps.rawScanRepo.mockImplementation(async () => ({ ok: true, worktrees: [gitWorktree(path)] }))

    await expect(
      resolveScopedWorktreeIdRow(deps, 'shared::D:\\Agentic\\game2\\battle-core', 'runtime:windows')
    ).resolves.toMatchObject({ id: `shared::${path}`, path })
  })
})

describe('scanRepoWorktreeRows lineage pruning', () => {
  // #16654: lineage written by a create that overtook the scan must survive its stale rows.
  it('keeps lineage recorded by a worktree change that overtook the scan', async () => {
    const owner = repo('repo-1', '/repo')
    const deps = createDeps([owner])
    const childId = 'repo-1::/repo-child'
    const lineageById: Record<string, WorktreeLineage> = {}
    const removeWorktreeLineage = vi.fn()
    Object.assign(deps.store, {
      getAllWorktreeLineage: () => lineageById,
      getWorktreeMeta: () => undefined,
      removeWorktreeLineage
    })
    deps.rawScanRepo.mockImplementationOnce(async () => {
      bumpLocalWorktreeScanGeneration(owner.id)
      lineageById[childId] = {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: 'repo-1::/repo',
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
      return { ok: true, worktrees: [gitWorktree('/repo')] }
    })

    await scanRepoWorktreeRows(deps, owner, new Map())

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
  })
})

describe('folder-to-Git checkout identity', () => {
  it.each([
    ['C:\\projects\\draft', 'C:/projects/draft'],
    ['C:\\projects\\draft', 'c:/projects/draft']
  ])(
    'preserves the live folder locator %s in desktop and runtime listings',
    async (folderPath, gitPath) => {
      const owner = {
        ...repo('folder', folderPath),
        kind: 'git' as const,
        folderUpgradeGitRootPath: gitPath
      }
      const deps = createDeps([owner])
      const oldId = `folder::${folderPath}`
      const metadata = mergeWorktreeMetaForWrite(undefined, {
        hostId: 'local',
        instanceId: 'existing-omp',
        comment: 'keep me'
      })
      deps.metaById[oldId] = metadata
      const detectedStore = Object.assign(deps.store, { getProjectHostSetups: () => [] })
      deps.rawScanRepo.mockResolvedValue({ ok: true, worktrees: [gitWorktree(gitPath)] })

      const detected = buildDetectedGitWorktrees(detectedStore, owner, [gitWorktree(gitPath)])
      const rows = await resolveRepoWorktreeRows(deps, owner, deps.metaById, new Map())
      for (const result of [detected, rows]) {
        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({
          id: oldId,
          path: folderPath,
          instanceId: 'existing-omp',
          comment: 'keep me'
        })
      }
      expect(Object.keys(deps.metaById)).toEqual([oldId])
    }
  )
})

it('retains bare storage for saved layouts without exposing a checkout or an import', () => {
  const owner = repo('bare', '/project/.bare')
  const deps = createDeps([owner])
  const detectedStore = Object.assign(deps.store, { getProjectHostSetups: () => [] })
  const worktrees = buildDetectedGitWorktrees(detectedStore, owner, [
    { ...gitWorktree('/project/.bare'), isBare: true, isMainWorktree: true, branch: '' },
    { ...gitWorktree('/project/a-stale'), prunable: true },
    gitWorktree('/project/main')
  ])
  expect(
    worktrees.map(({ id, visible, selectedCheckout, isMainWorktree }) => ({
      id,
      visible,
      selectedCheckout,
      isMainWorktree
    }))
  ).toEqual([
    { id: 'bare::/project/.bare', visible: false, selectedCheckout: false, isMainWorktree: true },
    { id: 'bare::/project/main', visible: true, selectedCheckout: false, isMainWorktree: false }
  ])
  expect(applyMetadataFallbackVisibility(worktrees[0]).visible).toBe(false)
  const detected = { repoId: 'bare', authoritative: true, source: 'git' as const, worktrees }
  expect(getHiddenImportableExternalWorktrees(detected)).toEqual([])
  const valid = buildValidWorktreeIdsForSessionHydration(
    {
      repos: [owner],
      worktreesByRepo: { bare: worktrees.filter((row) => row.visible) },
      detectedWorktreesByRepo: { bare: detected }
    },
    ['bare::/project/.bare', 'bare::/project/gone']
  )
  expect([...valid].sort()).toEqual(['bare::/project/.bare', 'bare::/project/main'])
})
describe('durable removal projection onto cached host rows', () => {
  it('retires admitted rows without another scan and fences old rows after cleanup, only on their host', async () => {
    const local = repo('shared', '/local/repo', { executionHostId: 'local' })
    const remote = repo('shared', '/remote/repo', { executionHostId: 'ssh:builder' })
    const deps = createDeps([local, remote])
    const scan = await scanRepoWorktreeRows(deps, local, new Map())
    const id = 'shared::/same/worktree'
    const record = {
      worktreeId: id,
      repoId: local.id,
      repoPath: local.path,
      worktreePath: '/same/worktree',
      branch: 'feature',
      head: 'abc123',
      deleteBranch: false,
      force: false,
      requestedAt: 1
    }
    pendingWorktreeRemovals.set(id, record)
    try {
      expect(projectRepoWorktreeRows(deps, local, scan, {})).toMatchObject([{ id }])
      expect(projectRepoWorktreeRows(deps, local, scan, {})[0].removalRecorded).toBeUndefined()
      recordedWorktreeRemovals.add(record)
      expect(projectRepoWorktreeRows(deps, local, scan, {})).toMatchObject([
        { id, removing: true, removalRecorded: true }
      ])
      expect(projectRepoWorktreeRows(deps, remote, scan, {})[0].removalRecorded).toBeUndefined()
      pendingWorktreeRemovals.delete(id)
      finishedWorktreeRemovals.add(record)
      expect(projectRepoWorktreeRows(deps, local, scan, {})).toEqual([])
      expect(projectRepoWorktreeRows(deps, remote, scan, {})).toMatchObject([{ id }])
    } finally {
      pendingWorktreeRemovals.delete(id)
    }
  })
})

it.each([
  [12, 750],
  [120, 7500]
])(
  'keeps removal witnesses repo-scoped without recopying on metadata joins (%i repos, %i removals)',
  (repoCount, removalCount) => {
    const repos = Array.from({ length: repoCount }, (_, i) =>
      repo(`fleet-${i}`, `/fleet/${i}`, { executionHostId: 'local' })
    )
    const deps = createDeps(repos)
    const scans: ResolvedWorktreeRepoScans = new Map(
      repos.map((owner) => [
        getRepoHostIdentityForParts(owner.id, 'local'),
        { ok: true, worktrees: [], gitRun: null }
      ])
    )
    const records = Array.from({ length: removalCount }, (_, i) => ({
      worktreeId: `fleet-0::/retiring/${i}`,
      repoId: 'fleet-0',
      repoPath: '/fleet/0',
      worktreePath: `/retiring/${i}`,
      branch: `feature-${i}`,
      head: 'abc123',
      force: false,
      deleteBranch: false,
      requestedAt: 1
    }))
    for (const record of records) {
      pendingWorktreeRemovals.set(record.worktreeId, record)
      recordedWorktreeRemovals.add(record)
    }
    const firstScan = scans.get(getRepoHostIdentityForParts('fleet-0', 'local'))!
    firstScan.worktrees = [gitWorktree('/retiring/0')]
    try {
      const joined = joinResolvedWorktreeScans(deps.store, () => deps, scans)
      expect(joined.worktrees).toMatchObject([{ id: records[0].worktreeId, removalRecorded: true }])
      expect([...scans.values()].map((scan) => scan.removals?.size ?? 0)).toEqual([
        removalCount,
        ...Array(repoCount - 1).fill(0)
      ])
      const witnesses = firstScan.removals!
      const enumerateWitnesses = vi.spyOn(witnesses, Symbol.iterator)
      const enumerateGlobal = vi.spyOn(pendingWorktreeRemovals, Symbol.iterator)
      try {
        deps.metaById[records[0].worktreeId] = mergeWorktreeMetaForWrite(undefined, {
          displayName: 'changed metadata'
        })
        joinResolvedWorktreeScans(deps.store, () => deps, scans)
        // Unrelated metadata cannot invalidate removal membership: no witness entries need copying.
        expect(enumerateWitnesses).not.toHaveBeenCalled()
        expect(enumerateGlobal).not.toHaveBeenCalled()
        expect(firstScan.removals).toBe(witnesses)
      } finally {
        enumerateWitnesses.mockRestore()
        enumerateGlobal.mockRestore()
      }
      pendingWorktreeRemovals.delete(records[0].worktreeId)
      finishedWorktreeRemovals.add(records[0])
      expect(joinResolvedWorktreeScans(deps.store, () => deps, scans).worktrees).toEqual([])
    } finally {
      for (const record of records) {
        pendingWorktreeRemovals.delete(record.worktreeId)
      }
    }
  }
)
