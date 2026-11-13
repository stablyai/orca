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
const {
  readWorktreeCatalog,
  invalidateWorktreeCatalogForRepo,
  retireObsoleteWorktreeCatalogs,
  peekWorktreeCatalog
} = await import('../../../workspaces/catalog/repo-worktree-catalog-owner')
const { setWorktreeCatalogRouteResolver } =
  await import('../../../workspaces/catalog/repo-worktree-catalog-route')
const { resolveWorktreeScanRuntime } =
  await import('../../../runtime/workspaces/catalog/runtime-worktree-scan-cache')
const adminFingerprint =
  await import('../../../runtime/workspaces/catalog/repo-worktree-admin-fingerprint')

const { Store } = await import('../../../persistence/loading-store/store')
const { listDetectedWorktreesForCapturedRepo } = await import('./detected-provider-listing')
const { __resetDetectedWorktreeScanCacheForTests, invalidateDetectedWorktreeScanCache } =
  await import('./detected-worktree-scan-cache')
const { captureGitWorktreeObservationCommit } =
  await import('../../../workspaces/catalog/git-worktree-observations')
const observationOwner = await import('../../../workspaces/catalog/git-worktree-observations')
const visibilitySources = await import('../../../../shared/worktree/visibility/visibility-sources')
const ownership = await import('../../../../shared/worktree/visibility/ownership')
const { getProjectHostSetupWorktreeMeta } =
  await import('../../../../shared/project-host-setup-lookup')
const { isLocalWorktreeMetadataPruneDue } =
  await import('../../../workspaces/catalog/local-worktree-metadata-prune-gate')

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

describe.each([750, 7500])('Git observation admission at %i tracked rows', (count) => {
  it('captures only fresh producers and avoids adoption preparation and writes for existing equal facts', async () => {
    const store = openStore()
    store.addRepo(owner)
    const setup = getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), owner)
    const facts = {
      isBare: false,
      isMainWorktree: false,
      branch: 'refs/heads/topic',
      prunable: false
    }
    const rows = Array.from({ length: count }, (_, i) => git(`/repo/topic-${i}`))
    for (const row of rows) {
      metadata(store, row.path, { ...setup, gitWorktree: facts, comment: 'saved content' })
    }
    const remote: Repo = { ...owner, connectionId: 'builder', executionHostId: 'ssh:builder' }
    store.addRepo(remote)
    const foreign = hostWorktreeTargetForRepo('observed::/repo/topic-0', remote)
    store.setWorktreeMeta(foreign, { ...setup, comment: 'foreign content', gitWorktree: facts })
    store.flushOrThrow()
    expect(Object.keys(store.getAllWorktreeMetaForHost('local'))).toHaveLength(count)
    const setter = vi.spyOn(store, 'setWorktreeMeta')
    const stateWritten = vi.fn()
    const metaWritten = vi.fn()
    const detachState = store.onStateWritten(stateWritten)
    const detachMeta = store.onWorktreeMetaWritten(metaWritten)
    const matchers = vi.spyOn(visibilitySources, 'createWorktreeVisibilitySourceMatcher')
    const layouts = vi.spyOn(ownership, 'buildKnownOrcaWorkspaceLayouts')
    try {
      captureGitWorktreeObservationCommit(store, owner).commit(rows)
      expect(setter).not.toHaveBeenCalled()
      expect(stateWritten).not.toHaveBeenCalled()
      expect(metaWritten).not.toHaveBeenCalled()
      expect(matchers).not.toHaveBeenCalled()
      expect(layouts).not.toHaveBeenCalled()
      const changedRows = [git('/repo/topic-0', { branch: 'refs/heads/changed' }), ...rows.slice(1)]
      captureGitWorktreeObservationCommit(store, owner).commit(changedRows)
      expect(setter).toHaveBeenCalledTimes(1)
      expect(metaWritten).toHaveBeenCalledTimes(1)
      expect(stateWritten).toHaveBeenCalledTimes(1)
      expect(matchers).not.toHaveBeenCalled()
      expect(layouts).not.toHaveBeenCalled()
      expect(store.getWorktreeMetaForHost('observed::/repo/topic-0', 'local')).toMatchObject({
        comment: 'saved content',
        gitWorktree: { branch: 'refs/heads/changed' }
      })
      expect(store.getWorktreeMetaForHost(foreign.id, 'ssh:builder')).toMatchObject({
        comment: 'foreign content',
        gitWorktree: { branch: 'refs/heads/topic' }
      })
      const newRows = [...changedRows, git('/repo/new')]
      captureGitWorktreeObservationCommit(store, owner).commit(newRows)
      expect(matchers.mock.calls.filter(([paths]) => paths.length > 1)).toHaveLength(1)
      expect(layouts).toHaveBeenCalledTimes(1)
      expect(store.getWorktreeMetaForHost('observed::/repo/new', 'local')?.gitWorktree).toEqual(
        facts
      )

      const capture = vi.spyOn(observationOwner, 'captureGitWorktreeObservationCommit')
      scanGit.mockResolvedValue(newRows)
      const fresh = await list(store)
      expect(fresh && 'worktrees' in fresh ? fresh.worktrees : []).toHaveLength(count + 1)
      expect(capture).toHaveBeenCalledTimes(1)
      capture.mockClear()
      await list(store)
      expect(capture).not.toHaveBeenCalled()
      expect(scanGit).toHaveBeenCalledTimes(1)
      invalidateDetectedWorktreeScanCache(owner.id)
      let resolveScan!: (value: GitWorktreeInfo[]) => void
      scanGit.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveScan = resolve
          })
      )
      const producer = list(store)
      const joined = list(store)
      expect(capture).toHaveBeenCalledTimes(1)
      expect(scanGit).toHaveBeenCalledTimes(2)
      resolveScan(newRows)
      const [produced, reused] = await Promise.all([producer, joined])
      expect(produced && 'worktrees' in produced ? produced.worktrees : []).toHaveLength(count + 1)
      expect(reused && 'worktrees' in reused ? reused.worktrees : []).toHaveLength(count + 1)
      expect(capture).toHaveBeenCalledTimes(1)
    } finally {
      detachState()
      detachMeta()
    }
  })

  it('does no second factual reconciliation when desktop reuses runtime-first rows after hygiene settled', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 100_000 })
    vi.spyOn(adminFingerprint, 'readRepoWorktreeAdminFingerprint').mockResolvedValue(null)
    const store = openStore()
    store.addRepo(owner)
    const setup = getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), owner)
    const facts = {
      isBare: false,
      isMainWorktree: false,
      branch: 'refs/heads/topic',
      prunable: false
    }
    const rows = Array.from({ length: count }, (_, i) => git(`/repo/handoff-${i}`))
    for (const row of rows) {
      metadata(store, row.path, { ...setup, gitWorktree: facts })
    }
    const runtime = new OrcaRuntimeService(store)
    const realCapture = observationOwner.captureGitWorktreeObservationCommit
    const captures: ReturnType<typeof realCapture>[] = []
    const capture = vi
      .spyOn(observationOwner, 'captureGitWorktreeObservationCommit')
      .mockImplementation((...args) => {
        const pending = realCapture(...args)
        vi.spyOn(pending, 'commit')
        captures.push(pending)
        return pending
      })
    const writes = vi.spyOn(store, 'setWorktreeMeta')
    scanGit.mockResolvedValue(rows)
    expect(await list(store)).toMatchObject({ authoritative: true })
    expect(isLocalWorktreeMetadataPruneDue(owner.id)).toBe(false)
    expect(captures[0].commit).toHaveBeenCalledTimes(1)

    runtime.invalidateWorktreeCatalog(owner.id)
    expect(isLocalWorktreeMetadataPruneDue(owner.id)).toBe(false)
    const produced = await runtime.listManagedWorktrees(undefined, count)
    expect(produced.worktrees).toHaveLength(count)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(captures[1].commit).toHaveBeenCalledTimes(1)
    expect(scanGit).toHaveBeenCalledTimes(2)
    expect(writes).not.toHaveBeenCalled()
    const runtimeKey = resolveWorktreeScanRuntime(store, owner).runtimeKey
    const observed = peekWorktreeCatalog(owner, runtimeKey)
    expect(observed?.current).toBe(true)
    expect(observed?.observation.startedBy).toBe('runtime')
    expect(observed?.observation.witness?.hygieneDue).toBe(false)
    expect(isLocalWorktreeMetadataPruneDue(owner.id)).toBe(false)

    const reused = await list(store)
    expect(reused && 'worktrees' in reused ? reused.worktrees : []).toHaveLength(count)
    expect(reused).toMatchObject({ authoritative: true })
    expect(peekWorktreeCatalog(owner, runtimeKey)?.observation).toBe(observed?.observation)
    expect(observed?.observation.witness).toBeUndefined()
    // These are spies on real commits, independent of the equality gate that saves setters.
    expect(captures[0].commit).toHaveBeenCalledTimes(1)
    expect(captures[1].commit).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(scanGit).toHaveBeenCalledTimes(2)
    expect(writes).not.toHaveBeenCalled()
  })

  it('releases real settled cohorts while retaining pending incarnation evidence and failure age', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 100_000 })
    const store = openStore()
    store.addRepo(owner)
    const facts = {
      isBare: false,
      isMainWorktree: false,
      branch: 'refs/heads/topic',
      prunable: false
    }
    const rows = Array.from({ length: count }, (_, i) => git(`/repo/lifetime-${i}`))
    for (const [i, row] of rows.entries()) {
      metadata(store, row.path, {
        instanceId: `before-${i}`,
        ...(i > 1 ? { gitWorktree: facts } : {})
      })
    }
    const runtimeKey = resolveWorktreeScanRuntime(store, owner).runtimeKey
    const capture = vi.fn(() => captureGitWorktreeObservationCommit(store, owner))
    let finish!: (outcome: WorktreeCatalogOutcome) => void
    const scan = vi.fn(
      () =>
        new Promise<WorktreeCatalogOutcome>((resolve) => {
          finish = resolve
        })
    )
    const probe = vi.fn(async () => 'stable')
    const requirement = {
      kind: 'runtime' as const,
      maxAgeMs: 1_000,
      reusesFailure: true,
      verifier: { ceilingMs: 300_000, timeoutMs: 100, probe }
    }
    const plan = { scan, captureObservation: capture }
    const read = () => readWorktreeCatalog(owner, runtimeKey, requirement, plan)
    const pending = read()
    expect(capture.mock.results[0].value._retainedEntryCountForTests()).toBe(count)
    metadata(store, rows[0].path, { instanceId: 'replacement', comment: 'new content' })
    const writes = vi.spyOn(store, 'setWorktreeMeta')
    finish({ kind: 'rows', worktrees: rows })
    const success = await pending
    expect(success.superseded).toBe(false)
    expect(store.getWorktreeMetaForHost('observed::/repo/lifetime-0', 'local')).toMatchObject({
      instanceId: 'replacement',
      comment: 'new content'
    })
    expect(store.getWorktreeMetaForHost('observed::/repo/lifetime-0', 'local')).not.toHaveProperty(
      'gitWorktree'
    )
    expect(
      store.getWorktreeMetaForHost('observed::/repo/lifetime-1', 'local')?.gitWorktree
    ).toEqual(facts)
    expect(writes).toHaveBeenCalledTimes(1)
    expect(capture.mock.results[0].value._retainedEntryCountForTests()).toBe(0)
    expect(success.observation).not.toHaveProperty('observationCommit')
    capture.mock.results[0].value.release()
    capture.mock.results[0].value.release()
    capture.mock.results[0].value.commit([git('/repo/not-observed')])
    expect(store.getWorktreeMetaForHost('observed::/repo/not-observed', 'local')).toBeUndefined()
    writes.mockClear()
    expect((await read()).observation).toBe(success.observation)
    vi.setSystemTime(102_000)
    expect((await read()).observation).toBe(success.observation)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(writes).not.toHaveBeenCalled()

    invalidateWorktreeCatalogForRepo(owner.id)
    const failedRead = read()
    expect(capture.mock.results[1].value._retainedEntryCountForTests()).toBe(count)
    finish({ kind: 'failed', error: new Error('offline') })
    const failed = await failedRead
    expect(failed.superseded).toBe(false)
    expect(failed.observation?.outcome.kind).toBe('failed')
    expect(failed.observation?.authorityCurrent?.()).toBe(true)
    expect(capture.mock.results[1].value._retainedEntryCountForTests()).toBe(0)
    expect((await read()).observation).toBe(failed.observation)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(writes).not.toHaveBeenCalled()

    invalidateWorktreeCatalogForRepo(owner.id)
    const overtaken = read()
    expect(capture.mock.results[2].value._retainedEntryCountForTests()).toBe(count)
    invalidateWorktreeCatalogForRepo(owner.id)
    expect(capture.mock.results[2].value._retainedEntryCountForTests()).toBe(0)
    finish({ kind: 'rows', worktrees: rows })
    expect((await overtaken).superseded).toBe(true)
    const retiring = read()
    expect(capture.mock.results[3].value._retainedEntryCountForTests()).toBe(count)
    setWorktreeCatalogRouteResolver(() => null)
    try {
      retireObsoleteWorktreeCatalogs()
      expect(capture.mock.results[3].value._retainedEntryCountForTests()).toBe(0)
      finish({ kind: 'rows', worktrees: rows })
      expect((await retiring).superseded).toBe(true)
      expect(writes).not.toHaveBeenCalled()
    } finally {
      setWorktreeCatalogRouteResolver(null)
    }
  })
})
