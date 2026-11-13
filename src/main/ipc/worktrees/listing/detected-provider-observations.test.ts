import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RepoWorktrees from '../../../workspaces/catalog/repo-worktrees'
import type * as ProjectRuntimeGitOptions from '../../../workspaces/execution-host/project-runtime-git-options'
import type * as RepoWorktreeResolutionScan from '../../../runtime/workspaces/catalog/repo-worktree-resolution-scan'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { WorktreeCatalogOutcome } from '../../../workspaces/catalog/repo-worktree-catalog-observation'
import { hostWorktreeTargetForRepo } from '../../../persistence/host-qualified-worktree-meta'
import { holdInFlightWorktreeCreate } from '../../../workspaces/creation/worktree-create-in-flight'
import {
  registerWorktreeChangeInvalidator,
  runWorktreeChangeInvalidators
} from './worktree-change-invalidators'
import { bumpWorktreeScanGeneration } from '../../../git/worktrees/catalog/worktree-scan-cache'
import { getLocalWorktreeScanGeneration } from '../../../workspaces/catalog/local-worktree-scan-generation'
import { pendingWorktreeRemovals } from '../../../workspaces/removal/worktree-removal-table'
import {
  closeTestStores,
  createSqliteTestStore
} from '../../../persistence/persistence-test-harness'

const { scanGit } = vi.hoisted(() => ({ scanGit: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {}, removeListener: () => {}, emit: () => true },
  BrowserWindow: { getAllWindows: () => [], fromId: () => null },
  webContents: { fromId: () => null }
}))
vi.mock('../../../workspaces/catalog/repo-worktrees', async (importOriginal) => ({
  ...(await importOriginal<typeof RepoWorktrees>()),
  listRepoWorktreesForDetectedScan: scanGit
}))
vi.mock(
  '../../../workspaces/execution-host/project-runtime-git-options',
  async (importOriginal) => ({
    ...(await importOriginal<typeof ProjectRuntimeGitOptions>()),
    getLocalProjectWorktreeGitOptions: () => ({})
  })
)
vi.mock(
  '../../../runtime/workspaces/catalog/repo-worktree-resolution-scan',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RepoWorktreeResolutionScan>()),
    scanLocalRepoWorktreesForResolution: async () => ({ ok: true, worktrees: await scanGit() })
  })
)
vi.mock('../removal/registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: () => 1,
  registerWorktreeRootsForRepo: vi.fn()
}))
vi.mock('../../../workspaces/catalog/worktree-lineage-pruning', () => ({
  pruneLineageForMissingRepoWorktrees: vi.fn()
}))
vi.mock('./authoritative-local-worktree-metadata-pruning', () => ({
  pruneMetadataMissingFromAuthoritativeLocalScan: vi.fn().mockResolvedValue({
    scanGenerationCurrent: true,
    preservedMetadataCandidateIds: new Set()
  })
}))

const { OrcaRuntimeService } = await import('../../../runtime/orca-runtime')
const removalListing = await import('../../../workspaces/removal/worktree-removal-listing')
const prune = await import('./authoritative-local-worktree-metadata-pruning')
const lineage = await import('../../../workspaces/catalog/worktree-lineage-pruning')
const { readWorktreeCatalog, invalidateWorktreeCatalogForRepo } =
  await import('../../../workspaces/catalog/repo-worktree-catalog-owner')
const { resolveWorktreeScanRuntime } =
  await import('../../../runtime/workspaces/catalog/runtime-worktree-scan-cache')

const { Store } = await import('../../../persistence/loading-store/store')
const { listDetectedWorktreesForCapturedRepo } = await import('./detected-provider-listing')
const { __resetDetectedWorktreeScanCacheForTests, invalidateDetectedWorktreeScanCache } =
  await import('./detected-worktree-scan-cache')
const { WslDistroStoppedError } = await import('../../../wsl/filesystem/wsl-unc-access-gate')
const { listWslStoppedWorktrees } = await import('./wsl-stopped-worktree-listing')
const { captureGitWorktreeObservationCommit } =
  await import('../../../workspaces/catalog/git-worktree-observations')
const observationOwner = await import('../../../workspaces/catalog/git-worktree-observations')

const owner: Repo = {
  id: 'observed',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1,
  externalWorktreeVisibility: 'show'
}
function git(path: string, updates: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path,
    head: 'abc',
    branch: 'refs/heads/topic',
    isBare: false,
    isMainWorktree: false,
    ...updates
  }
}
function openStore(
  dataFile = join(realpathSync(mkdtempSync(join(tmpdir(), 'orca-observed-'))), 'state.json')
) {
  return createSqliteTestStore(Store, { dataFile })
}
function metadata(store: InstanceType<typeof Store>, path: string, updates = {}) {
  return store.setWorktreeMeta(hostWorktreeTargetForRepo(`${owner.id}::${path}`, owner), updates)
}
function list(store: InstanceType<typeof Store>, current = () => true, signal?: AbortSignal) {
  return listDetectedWorktreesForCapturedRepo(
    store,
    owner,
    current,
    signal ? { signal, status: () => 'canceled' } : undefined
  )
}
beforeEach(() => {
  __resetDetectedWorktreeScanCacheForTests()
  scanGit.mockReset()
})
afterEach(async () => {
  await closeTestStores()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('successful Git observations survive unavailable scans', () => {
  it('does not adopt a retired create scan through either its producer or joiner', async () => {
    const store = openStore()
    store.addRepo(owner)
    const unregister = registerWorktreeChangeInvalidator(invalidateDetectedWorktreeScanCache)
    const release = await holdInFlightWorktreeCreate(owner.id, '/repo/creating', () => {
      runWorktreeChangeInvalidators(owner.id)
      bumpWorktreeScanGeneration(owner.path)
    })
    let finish!: (rows: GitWorktreeInfo[]) => void
    scanGit.mockImplementationOnce(
      () =>
        new Promise<GitWorktreeInfo[]>((resolve) => {
          finish = resolve
        })
    )
    // A different later result proves neither caller publishes or adopts the retired raw read.
    scanGit.mockResolvedValue([git('/repo/fresh')])
    try {
      const producer = list(store)
      const joiner = list(store)
      release()
      finish([git('/repo/creating')])
      for (const result of await Promise.all([producer, joiner])) {
        expect(result).toMatchObject({ authoritative: true, worktrees: [{ path: '/repo/fresh' }] })
      }
      expect(store.getWorktreeMetaForHost('observed::/repo/creating', 'local')).toBeUndefined()
      scanGit.mockResolvedValue([git('/repo/creating')])
      invalidateDetectedWorktreeScanCache(owner.id)
      expect(await list(store)).toMatchObject({ worktrees: [{ path: '/repo/creating' }] })
      expect(
        store.getWorktreeMetaForHost('observed::/repo/creating', 'local')?.gitWorktree
      ).toMatchObject({ isBare: false, branch: 'refs/heads/topic' })
    } finally {
      release()
      unregister()
    }
  })
  it('uses the current incarnation after a deferred stopped scan fails', async () => {
    const store = openStore()
    store.addRepo(owner)
    metadata(store, '/repo/topic', {
      instanceId: 'before',
      gitWorktree: { isBare: true, isMainWorktree: true, branch: '', prunable: false }
    })
    let rejectScan!: (error: Error) => void
    scanGit.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectScan = reject
        })
    )
    const result = list(store)
    metadata(store, '/repo/topic', { instanceId: 'after', comment: 'replacement' })
    rejectScan(new WslDistroStoppedError('Ubuntu'))
    expect(await result).toMatchObject({
      authoritative: false,
      worktrees: [
        { path: '/repo', isBare: false, isMainWorktree: true, visible: true },
        {
          path: '/repo/topic',
          isBare: false,
          visible: true,
          instanceId: 'after',
          comment: 'replacement'
        }
      ]
    })
  })

  it('does not borrow retired observations after a deferred ordinary scan fails', async () => {
    const store = openStore()
    store.addRepo(owner)
    metadata(store, '/repo/topic', {
      instanceId: 'before',
      gitWorktree: { isBare: true, isMainWorktree: true, branch: '', prunable: false }
    })
    let rejectScan!: (error: Error) => void
    scanGit.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectScan = reject
        })
    )
    const result = list(store)
    metadata(store, '/repo/topic', {
      instanceId: 'after',
      comment: 'replacement'
    })
    rejectScan(new Error('scan unavailable'))
    expect(await result).toMatchObject({
      authoritative: false,
      worktrees: []
    })
  })
  it('leaves held creations unadopted until a subsequent completed scan', async () => {
    const store = openStore()
    store.addRepo(owner)
    const unregister = registerWorktreeChangeInvalidator(invalidateDetectedWorktreeScanCache)
    const release = await holdInFlightWorktreeCreate(owner.id, '/repo/creating', () => {
      runWorktreeChangeInvalidators(owner.id)
      bumpWorktreeScanGeneration(owner.path)
    })
    scanGit.mockResolvedValue([git('/repo/creating')])
    try {
      expect(await list(store)).toMatchObject({ worktrees: [] })
      expect(store.getWorktreeMetaForHost('observed::/repo/creating', 'local')).toBeUndefined()
    } finally {
      release()
      unregister()
    }
    invalidateDetectedWorktreeScanCache(owner.id)
    scanGit.mockResolvedValue([])
    await list(store)
    expect(store.getWorktreeMetaForHost('observed::/repo/creating', 'local')).toBeUndefined()
    scanGit.mockResolvedValue([git('/repo/creating')])
    invalidateDetectedWorktreeScanCache(owner.id)
    expect(await list(store)).toMatchObject({
      worktrees: [{ path: '/repo/creating', visible: true }]
    })
    expect(store.getWorktreeMetaForHost('observed::/repo/creating', 'local')?.gitWorktree).toEqual({
      isBare: false,
      isMainWorktree: false,
      branch: 'refs/heads/topic',
      prunable: false
    })
  })

  it('does not stamp a removal pending at scan start or accepted before commit', () => {
    const store = openStore()
    store.addRepo(owner)
    const id = 'observed::/repo/removing'
    metadata(store, '/repo/removing', { instanceId: 'original', comment: 'retained retry' })
    const removal = {
      worktreeId: id,
      repoId: owner.id,
      repoPath: owner.path,
      worktreePath: '/repo/removing',
      branch: 'topic',
      head: 'abc',
      requestedAt: 1,
      deleteBranch: false,
      force: false
    }
    pendingWorktreeRemovals.set(id, removal)
    const prior = captureGitWorktreeObservationCommit(store, owner)
    pendingWorktreeRemovals.delete(id)
    prior.commit([git('/repo/removing')])
    expect(store.getWorktreeMetaForHost(id, 'local')).not.toHaveProperty('gitWorktree')
    const concurrent = captureGitWorktreeObservationCommit(store, owner)
    pendingWorktreeRemovals.set(id, removal)
    try {
      concurrent.commit([git('/repo/removing')])
      expect(store.getWorktreeMetaForHost(id, 'local')).toMatchObject({
        instanceId: 'original',
        comment: 'retained retry'
      })
      expect(store.getWorktreeMetaForHost(id, 'local')).not.toHaveProperty('gitWorktree')
    } finally {
      pendingWorktreeRemovals.delete(id)
    }
  })
  it('reloads hidden bare and genuine tracked rows without inventing a Primary', async () => {
    const dataFile = join(realpathSync(mkdtempSync(join(tmpdir(), 'orca-offline-'))), 'state.json')
    const first = openStore(dataFile)
    first.addRepo(owner)
    const original = metadata(first, '/repo/.bare', {
      comment: 'retained content',
      instanceId: 'bare-instance'
    })
    scanGit.mockResolvedValue([
      git('/repo/.bare', { isBare: true, isMainWorktree: true, branch: '' }),
      git('/repo/topic'),
      git('/repo/untracked-detached', { branch: '' }),
      git('/repo/untracked-prunable', { prunable: true })
    ])
    const online = await list(first)
    expect(online).toMatchObject({
      authoritative: true,
      worktrees: [
        { path: '/repo/.bare', isBare: true, isMainWorktree: true, visible: false },
        { path: '/repo/topic', isMainWorktree: false, visible: true },
        { path: '/repo/untracked-detached', visible: false }
      ]
    })
    expect(first.getWorktreeMetaForHost('observed::/repo/.bare', 'local')).toMatchObject({
      instanceId: original.instanceId,
      comment: 'retained content',
      gitWorktree: { isBare: true, isMainWorktree: true, branch: '', prunable: false }
    })
    first.flush()
    await first.freezeWritesAsync()
    const cold = openStore(dataFile)
    __resetDetectedWorktreeScanCacheForTests()
    scanGit.mockRejectedValue(new WslDistroStoppedError('Ubuntu'))
    const offline = await list(cold)
    expect(offline).toMatchObject({
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: [
        { path: '/repo/.bare', isBare: true, isMainWorktree: true, visible: false },
        { path: '/repo/topic', isMainWorktree: false, branch: 'refs/heads/topic', visible: true }
      ]
    })
    expect(
      offline && 'worktrees' in offline ? offline.worktrees.map((row) => row.path) : []
    ).toEqual(['/repo/.bare', '/repo/topic'])
    cold.updateRepo({ id: owner.id }, { externalWorktreeVisibility: null })
    cold.updateRepo({ id: owner.id }, { externalWorktreeVisibility: 'hide' })
    expect(
      listWslStoppedWorktrees(cold, cold.getRepo(owner.id)!, cold.getAllWorktreeMeta()).find(
        (row) => row.path === '/repo/topic'
      )?.visible
    ).toBe(false)
  })

  it('keeps missing-fact rows individually and an entirely uninitialized catalog on the legacy path', () => {
    const store = openStore()
    store.addRepo(owner)
    metadata(store, '/repo/.bare', {
      gitWorktree: { isBare: true, isMainWorktree: true, branch: '', prunable: false }
    })
    metadata(store, '/repo/legacy')
    expect(listWslStoppedWorktrees(store, owner, store.getAllWorktreeMeta())).toMatchObject([
      { path: '/repo/.bare', isBare: true, visible: false },
      { path: '/repo/legacy', branch: '', isBare: false, visible: true }
    ])
    const empty = openStore()
    empty.addRepo(owner)
    expect(listWslStoppedWorktrees(empty, owner, {})).toMatchObject([
      { path: '/repo', isMainWorktree: true, visible: true }
    ])
  })

  it('settles valid host facts despite view cancellation, avoids replay writes, and heals on a new success', async () => {
    const store = openStore()
    store.addRepo(owner)
    metadata(store, '/repo/topic')
    const controller = new AbortController()
    scanGit.mockImplementationOnce(async () => {
      controller.abort()
      return [git('/repo/topic')]
    })
    expect(await list(store, () => true, controller.signal)).toEqual({
      providerAbortStatus: 'canceled'
    })
    expect(store.getWorktreeMetaForHost('observed::/repo/topic', 'local')?.gitWorktree).toEqual({
      isBare: false,
      isMainWorktree: false,
      branch: 'refs/heads/topic',
      prunable: false
    })
    const writes = vi.spyOn(store, 'setWorktreeMeta')
    await list(store)
    expect(writes.mock.calls).toEqual([
      [
        hostWorktreeTargetForRepo('observed::/repo/topic', owner),
        { projectId: 'repo:observed', projectHostSetupId: 'observed' }
      ]
    ])
    expect(writes.mock.calls[0][1]).not.toHaveProperty('gitWorktree')
    writes.mockClear()
    await list(store)
    expect(writes).not.toHaveBeenCalled()
    invalidateDetectedWorktreeScanCache(owner.id)
    scanGit.mockResolvedValue([
      git('/repo/topic', { isBare: true, isMainWorktree: true, branch: '', prunable: true })
    ])
    await list(store)
    expect(store.getWorktreeMetaForHost('observed::/repo/topic', 'local')?.gitWorktree).toEqual({
      isBare: true,
      isMainWorktree: true,
      branch: '',
      prunable: true
    })
    invalidateDetectedWorktreeScanCache(owner.id)
    scanGit.mockResolvedValue([git('/repo/topic')])
    await list(store)
    expect(store.getWorktreeMetaForHost('observed::/repo/topic', 'local')?.gitWorktree).toEqual({
      isBare: false,
      isMainWorktree: false,
      branch: 'refs/heads/topic',
      prunable: false
    })
  })

  it('settles desktop facts before a canceled hygiene claimant and runtime reuse, then reloads offline', async () => {
    const dataFile = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'orca-shared-settlement-'))),
      'state.json'
    )
    const store = openStore(dataFile)
    store.addRepo(owner)
    metadata(store, '/repo/.bare', {
      instanceId: 'original-bare',
      comment: 'saved content',
      gitWorktree: {
        isBare: false,
        isMainWorktree: false,
        branch: 'refs/heads/old',
        prunable: false
      }
    })
    metadata(store, '/repo/topic', { instanceId: 'original-topic' })
    const runtime = new OrcaRuntimeService(store)
    vi.mocked(prune.pruneMetadataMissingFromAuthoritativeLocalScan).mockClear()
    vi.mocked(lineage.pruneLineageForMissingRepoWorktrees).mockClear()
    const capture = vi.spyOn(observationOwner, 'captureGitWorktreeObservationCommit')
    const writes = vi.spyOn(store, 'setWorktreeMeta')
    const controller = new AbortController()
    let resume!: () => void
    let entered!: () => void
    const overlayEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const overlayGate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const augment = removalListing.withUnregisteredRemovalCheckouts
    vi.spyOn(removalListing, 'withUnregisteredRemovalCheckouts').mockImplementationOnce(
      async (id, rows) => {
        entered()
        await overlayGate
        return augment(id, rows)
      }
    )
    const rawRows = [
      git('/repo/.bare', { isBare: true, isMainWorktree: true, branch: '' }),
      git('/repo/topic')
    ]
    scanGit.mockResolvedValue(rawRows)
    const scanGeneration = getLocalWorktreeScanGeneration(owner.id)
    const runtimeLineageArgs = [store, store.getRepo(owner.id), rawRows, { scanGeneration }]
    const desktop = list(store, () => true, controller.signal)
    await overlayEntered
    try {
      expect(lineage.pruneLineageForMissingRepoWorktrees).not.toHaveBeenCalled()
      expect(prune.pruneMetadataMissingFromAuthoritativeLocalScan).not.toHaveBeenCalled()
      controller.abort()
      const reused = await runtime.listManagedWorktrees()
      expect(reused.worktrees.map((row) => row.path)).toEqual(['/repo/topic'])
      expect(capture).toHaveBeenCalledTimes(1)
      expect(scanGit).toHaveBeenCalledTimes(1)
      expect(writes.mock.calls.filter(([, update]) => update.gitWorktree)).toHaveLength(2)
      expect(capture.mock.results[0].value._retainedEntryCountForTests()).toBe(0)
      expect(vi.mocked(lineage.pruneLineageForMissingRepoWorktrees).mock.calls).toEqual([
        runtimeLineageArgs
      ])
    } finally {
      resume()
    }
    expect(await desktop).toEqual({ providerAbortStatus: 'canceled' })
    expect(prune.pruneMetadataMissingFromAuthoritativeLocalScan).not.toHaveBeenCalled()
    expect(vi.mocked(lineage.pruneLineageForMissingRepoWorktrees).mock.calls).toEqual([
      runtimeLineageArgs
    ])
    expect(store.getWorktreeMetaForHost('observed::/repo/.bare', 'local')).toMatchObject({
      instanceId: 'original-bare',
      comment: 'saved content',
      gitWorktree: { isBare: true, isMainWorktree: true, branch: '', prunable: false }
    })
    store.flushOrThrow()
    await store.freezeWritesAsync()
    const cold = openStore(dataFile)
    __resetDetectedWorktreeScanCacheForTests()
    scanGit.mockRejectedValue(new WslDistroStoppedError('Ubuntu'))
    expect(await list(cold)).toMatchObject({
      authoritative: false,
      worktrees: [
        {
          path: '/repo/.bare',
          instanceId: 'original-bare',
          comment: 'saved content',
          visible: false,
          isBare: true
        },
        { path: '/repo/topic', instanceId: 'original-topic', visible: true, isMainWorktree: false }
      ]
    })
  })

  it('withholds facts for a real stored-owner conflict and heals on a qualified successor', async () => {
    const store = openStore()
    store.addRepo(owner)
    const remote: Repo = { ...owner, executionHostId: 'ssh:foreign', connectionId: 'foreign' }
    const target = hostWorktreeTargetForRepo('observed::/repo/topic', remote)
    store.setWorktreeMeta(target, { instanceId: 'foreign-original', comment: 'foreign content' })
    expect(store.getWorktreeMeta('observed::/repo/topic')?.hostId).toBe('ssh:foreign')
    scanGit.mockResolvedValue([git('/repo/topic')])
    await list(store)
    expect(store.getWorktreeMeta('observed::/repo/topic')).not.toHaveProperty('gitWorktree')
    expect(store.getWorktreeMetaForHost(target.id, 'ssh:foreign')?.comment).toBe('foreign content')
    store.removeWorktreeMeta(target)
    metadata(store, '/repo/topic', { instanceId: 'qualified-successor' })
    invalidateDetectedWorktreeScanCache(owner.id)
    expect(await list(store)).toMatchObject({
      authoritative: true,
      worktrees: [{ path: '/repo/topic' }]
    })
    expect(
      store.getWorktreeMetaForHost('observed::/repo/topic', 'local')?.gitWorktree
    ).toMatchObject({ branch: 'refs/heads/topic' })
  })

  it('releases empty and exceptional settlements without admitting successful facts', async () => {
    const store = openStore()
    store.addRepo(owner)
    metadata(store, '/repo/topic', { instanceId: 'original' })
    const runtimeKey = resolveWorktreeScanRuntime(store, owner).runtimeKey
    const captures: ReturnType<typeof captureGitWorktreeObservationCommit>[] = []
    const plan = {
      captureObservation: () => {
        const capture = captureGitWorktreeObservationCommit(store, owner)
        captures.push(capture)
        return capture
      },
      scan: vi.fn(async (): Promise<WorktreeCatalogOutcome> => ({ kind: 'true-empty' })),
      observed: vi.fn()
    }
    const read = () =>
      readWorktreeCatalog(owner, runtimeKey, { kind: 'runtime', maxAgeMs: 1_000 }, plan)
    expect((await read()).observation?.outcome.kind).toBe('true-empty')
    expect(captures[0]._retainedEntryCountForTests()).toBe(0)
    expect(store.getWorktreeMetaForHost('observed::/repo/topic', 'local')).not.toHaveProperty(
      'gitWorktree'
    )
    invalidateWorktreeCatalogForRepo(owner.id)
    plan.observed.mockClear()
    plan.scan.mockResolvedValue({ kind: 'rows', worktrees: [git('/repo/topic')] })
    const writeError = new Error('metadata write failed')
    const write = vi.spyOn(store, 'setWorktreeMeta').mockImplementationOnce(() => {
      throw writeError
    })
    const failed = await read()
    expect(failed.observation?.outcome).toEqual({ kind: 'failed', error: writeError })
    expect(captures[1]._retainedEntryCountForTests()).toBe(0)
    expect(plan.observed).not.toHaveBeenCalled()
    expect(store.getWorktreeMetaForHost('observed::/repo/topic', 'local')).not.toHaveProperty(
      'gitWorktree'
    )
    write.mockRestore()
    invalidateWorktreeCatalogForRepo(owner.id)
    const detach = store.onWorktreeMetaWritten(() => invalidateWorktreeCatalogForRepo(owner.id))
    try {
      // The setter is synchronous: its listener can withdraw authority before cache admission.
      expect((await read()).superseded).toBe(true)
      expect(captures[2]._retainedEntryCountForTests()).toBe(0)
      expect(plan.observed).not.toHaveBeenCalled()
    } finally {
      detach()
    }
    invalidateWorktreeCatalogForRepo(owner.id)
    expect((await read()).observation?.outcome.kind).toBe('rows')
    expect(
      store.getWorktreeMetaForHost('observed::/repo/topic', 'local')?.gitWorktree
    ).toMatchObject({ branch: 'refs/heads/topic' })
  })

  it('rejects a predecessor observation after path identity or execution-space changes', () => {
    const store = openStore()
    store.addRepo(owner)
    metadata(store, '/repo/topic', { instanceId: 'before' })
    const prior = captureGitWorktreeObservationCommit(store, owner)
    metadata(store, '/repo/topic', { instanceId: 'after', comment: 'new content' })
    prior.commit([git('/repo/topic', { isBare: true })])
    expect(store.getWorktreeMetaForHost('observed::/repo/topic', 'local')).toMatchObject({
      instanceId: 'after',
      comment: 'new content'
    })
    expect(store.getWorktreeMetaForHost('observed::/repo/topic', 'local')).not.toHaveProperty(
      'gitWorktree'
    )
    const setupAttempt = captureGitWorktreeObservationCommit(store, owner)
    const setup = store.getProjectHostSetups()[0]!
    const setupRead = vi
      .spyOn(store, 'getProjectHostSetups')
      .mockReturnValue([{ ...setup, path: '/changed-independent-setup' }])
    setupAttempt.commit([git('/repo/topic')])
    expect(store.getWorktreeMetaForHost('observed::/repo/topic', 'local')).not.toHaveProperty(
      'gitWorktree'
    )
    setupRead.mockRestore()
    const moved = captureGitWorktreeObservationCommit(store, owner)
    vi.spyOn(store, 'getRepos').mockReturnValue([{ ...owner, path: '/different' }])
    moved.commit([git('/repo/topic')])
    expect(store.getWorktreeMetaForHost('observed::/repo/topic', 'local')).not.toHaveProperty(
      'gitWorktree'
    )
  })

  it('does not borrow another host or retired setup observation to suppress a legacy root', () => {
    const store = openStore()
    store.addRepo(owner)
    const remote: Repo = { ...owner, connectionId: 'builder', executionHostId: 'ssh:builder' }
    store.addRepo(remote)
    store.setWorktreeMeta(hostWorktreeTargetForRepo('observed::/repo/remote', remote), {
      gitWorktree: { isBare: true, isMainWorktree: true, branch: '', prunable: false }
    })
    metadata(store, '/repo/old-setup', {
      projectHostSetupId: 'retired-setup',
      gitWorktree: { isBare: true, isMainWorktree: true, branch: '', prunable: false }
    })
    const rows = listWslStoppedWorktrees(store, owner, store.getAllWorktreeMetaForHost('local'))
    expect(rows.map((row) => row.path)).toEqual(['/repo', '/repo/old-setup'])
    expect(rows[0]).toMatchObject({ isMainWorktree: true, visible: true })
  })

  it('leaves never-observed direct SSH metadata on its existing fallback without a local scan', async () => {
    const store = openStore()
    const remote: Repo = { ...owner, connectionId: 'builder', executionHostId: 'ssh:builder' }
    store.addRepo(remote)
    store.setWorktreeMeta(hostWorktreeTargetForRepo('observed::/repo/topic', remote), {
      comment: 'saved remote'
    })
    const result = await listDetectedWorktreesForCapturedRepo(store, remote, () => true)
    expect(result).toMatchObject({
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: [
        {
          path: '/repo/topic',
          isBare: false,
          isMainWorktree: false,
          branch: '',
          visible: true,
          comment: 'saved remote'
        }
      ]
    })
    expect(scanGit).not.toHaveBeenCalled()
    expect(store.getWorktreeMetaForHost('observed::/repo/topic', 'ssh:builder')).not.toHaveProperty(
      'gitWorktree'
    )
  })

  it('retains an already tracked detached workspace while refusing new detached adoption', async () => {
    const store = openStore()
    store.addRepo(owner)
    metadata(store, '/repo/tracked', { instanceId: 'retained', comment: 'saved' })
    scanGit.mockResolvedValue([
      git('/repo/tracked', { branch: '' }),
      git('/repo/new', { branch: '' })
    ])
    expect(await list(store)).toMatchObject({
      worktrees: [
        { path: '/repo/tracked', visible: true, instanceId: 'retained' },
        { path: '/repo/new', visible: false }
      ]
    })
    expect(store.getWorktreeMetaForHost('observed::/repo/new', 'local')).toBeUndefined()
  })
})
