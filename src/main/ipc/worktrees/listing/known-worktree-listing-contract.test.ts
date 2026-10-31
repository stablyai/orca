import {
  repo,
  child,
  childId,
  oid,
  row,
  fixture,
  Runtime
} from './known-worktree-listing-contract.test-fixture'
import type * as WslUncAccessGateModule from '../../../wsl/wsl-unc-access-gate'
import type * as WslStoppedWorktreeListingModule from './wsl-stopped-worktree-listing'
import type * as AuthoritativeLocalWorktreeMetadataPruningModule from './authoritative-local-worktree-metadata-pruning'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import type * as Fs from 'node:fs/promises'
import type { Repo } from '../../../../shared/repo-types'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../../shared/constants'
import { useWorktreeAwarenessEnvironment } from '../../../../cli/index-test-harness'
import { main as cliMain } from '../../../../cli/index'
import { okFixture } from '../../../../cli/test-fixtures'
import { TestPhone } from '../../../runtime/sidebar-inputs/sidebar-inputs-feed.test-fixture'
import { readSidebarFeedDomains } from '../../../../shared/sidebar-list/sidebar-feed-domains'
import { readFeedWorkspaceRow } from '../../../../shared/sidebar-list/sidebar-feed-worktrees'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getProjectHostSetupWorktreeMeta } from '../../../../shared/project-host-setup-lookup'
import { storeProject, storeWorktreeMeta } from '../../../runtime/runtime-store-partial-fixture'

const { statProbe, realpathProbe, gitRead, rawScan, gate, wake } = vi.hoisted(() => ({
  statProbe: vi.fn(async (_path: string) => ({ isDirectory: () => true })),
  realpathProbe: vi.fn(async (path: string) => path),
  gitRead: vi.fn(),
  rawScan: vi.fn(),
  gate: vi.fn(async (_path: string) => {}),
  wake: vi.fn()
}))
const cliMocks = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/pr36536-cli-fixture'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))
vi.mock('../../../../cli/runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('../../../../cli/index-test-harness')
  return createRuntimeClientModuleMock(cliMocks)
})
vi.mock('../../../../cli/runtime/environments', () => ({
  addEnvironmentFromPairingCode: cliMocks.addEnvironmentFromPairingCodeMock,
  listEnvironments: cliMocks.listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))
vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof Fs>()),
  stat: statProbe,
  realpath: realpathProbe
}))
vi.mock('../../../git/runner', () => ({
  gitExecFileAsync: gitRead,
  translateWslOutputPaths: (text: string) => text
}))
vi.mock('../../../repo-worktrees', () => ({ listRepoWorktreesForDetectedScan: rawScan }))
vi.mock('../../../wsl/wsl-unc-access-gate', async (original) => ({
  ...(await original<WslUncAccessGateModule>()),
  assertWslUncPathRunning: gate
}))
vi.mock('./wsl-stopped-worktree-listing', async (original) => ({
  ...(await original<WslStoppedWorktreeListingModule>()),
  rescanWorktreesWhenWslDistroRuns: wake
}))
vi.mock('../../registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: () => 0,
  registerWorktreeRootsForRepo: vi.fn()
}))
vi.mock('./authoritative-local-worktree-metadata-pruning', async (original) => ({
  ...(await original<AuthoritativeLocalWorktreeMetadataPruningModule>()),
  pruneMetadataMissingFromAuthoritativeLocalScan: vi.fn(async () => ({
    scanGenerationCurrent: true,
    preservedMetadataCandidateIds: new Set()
  }))
}))

import { listDetectedWorktreesForCapturedRepo } from './detected-provider-listing'
import {
  __resetDetectedWorktreeScanCacheForTests,
  invalidateDetectedWorktreeScanCache
} from './detected-worktree-scan-cache'
import { WslDistroStoppedError } from '../../../wsl/wsl-unc-access-gate'
import { Store } from '../../../persistence/loading-store/store'
import { removeWorktreeMetaRow } from '../../../persistence/host-qualified-worktree-meta'
import {
  startBackgroundWorktreeRemoval,
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests
} from '../../../worktree-background-removal'
import { pendingWorktreeRemovals, failedWorktreeRemovals } from '../../../worktree-removal-table'
import { registerWorktreeChangeInvalidator } from '../../worktree-change-invalidators'
import { knownWorktreeInventory } from '../../../known-worktree-inventory'
import { scanRepoWorktreeRows } from '../../../runtime/repo-worktree-row-resolution'

beforeEach(() => {
  __resetDetectedWorktreeScanCacheForTests()
  statProbe.mockReset().mockResolvedValue({ isDirectory: () => true })
  realpathProbe.mockReset().mockImplementation(async (path) => path)
  gitRead.mockReset().mockImplementation(async (args: string[]) => ({
    stdout: args.includes('--show-prefix') ? `\n${oid}\n` : 'refs/heads/feature',
    stderr: ''
  }))
  rawScan.mockReset().mockResolvedValue([row()])
  gate.mockReset().mockResolvedValue(undefined)
  wake.mockReset()
})
afterEach(async () => {
  await _settlePendingWorktreeRemovalsForTests()
  _resetPendingWorktreeRemovalsForTests()
  vi.useRealTimers()
})

it('publishes prunable saved rows through the final builder and safely fails unknown Git, with recovery', async () => {
  const { store } = fixture()
  rawScan.mockResolvedValue([
    row(),
    { ...row(child), prunable: true },
    { ...row('/unowned'), prunable: true }
  ])
  const prunable = await listDetectedWorktreesForCapturedRepo(store, repo, () => true)
  expect(prunable).toMatchObject({
    authoritative: true,
    worktrees: [
      expect.objectContaining({ path: repo.path }),
      expect.objectContaining({ path: child, linkedPR: 42 })
    ]
  })
  expect(gitRead).not.toHaveBeenCalled()
  invalidateDetectedWorktreeScanCache(repo.id)
  rawScan.mockResolvedValue([row()])
  gitRead.mockRejectedValue(new Error('unavailable checkout'))
  const writes = vi.spyOn(store, 'setWorktreeMeta')
  writes.mockClear()
  expect(await listDetectedWorktreesForCapturedRepo(store, repo, () => true)).toMatchObject({
    authoritative: false,
    worktrees: []
  })
  expect(writes).not.toHaveBeenCalled()
  // Failed derived results cannot swallow a subsequent recovery against the same raw cache.
  gitRead.mockImplementation(async (args: string[]) => ({
    stdout: args.includes('--show-prefix') ? `\n${oid}\n` : 'refs/heads/feature',
    stderr: ''
  }))
  expect(await listDetectedWorktreesForCapturedRepo(store, repo, () => true)).toMatchObject({
    authoritative: true,
    worktrees: expect.arrayContaining([expect.objectContaining({ path: child, linkedPR: 42 })])
  })
})

it('does not use cached main rows as availability and orders child absence before root and external location', async () => {
  const { store, session, changed } = fixture()
  await listDetectedWorktreesForCapturedRepo(store, repo, () => true)
  // Force a new proof inside the raw TTL, without refreshing raw Git.
  session.tabsByWorktree['r::/work/new-child'] = []
  changed()
  let reachable = false
  statProbe.mockImplementation(async (path) => {
    if (path === child || path === '/work/new-child' || (!reachable && path === repo.path)) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    return { isDirectory: () => true }
  })
  gitRead.mockRejectedValue(new Error('offline'))
  expect(await listDetectedWorktreesForCapturedRepo(store, repo, () => true)).toMatchObject({
    authoritative: false,
    worktrees: []
  })
  const paths = statProbe.mock.calls.map(([path]) => path)
  expect(paths.lastIndexOf(child)).toBeLessThan(paths.lastIndexOf(repo.path))
  expect(rawScan).toHaveBeenCalledTimes(1)
  reachable = true
  expect(await listDetectedWorktreesForCapturedRepo(store, repo, () => true)).toMatchObject({
    authoritative: true,
    worktrees: [expect.objectContaining({ path: repo.path })]
  })
})

it('gates a stopped UNC child before any filesystem or Git touch on a native repo, then recovers', async () => {
  const unc = String.raw`\\wsl.localhost\Ubuntu\home\feature`
  const { store } = fixture([repo], [unc])
  gate.mockImplementation(async (path) => {
    if (path === unc) {
      throw new WslDistroStoppedError('Ubuntu')
    }
  })
  expect(await listDetectedWorktreesForCapturedRepo(store, repo, () => true)).toMatchObject({
    authoritative: false,
    worktrees: [],
    wslDistroStopped: { distro: 'Ubuntu' }
  })
  expect(statProbe).not.toHaveBeenCalled()
  expect(realpathProbe).not.toHaveBeenCalled()
  expect(gitRead).not.toHaveBeenCalled()
  expect(wake).toHaveBeenCalledWith(repo.id, 'Ubuntu')
  gate.mockResolvedValue(undefined)
  expect(await listDetectedWorktreesForCapturedRepo(store, repo, () => true)).toMatchObject({
    authoritative: true,
    worktrees: expect.arrayContaining([expect.objectContaining({ path: unc })])
  })
})

it('withdraws runtime evidence after final ownership changes and keeps current stored display without stamping', async () => {
  const { store, meta, session, changed } = fixture()
  const runtime = new Runtime(store)
  const observed = await runtime.listing()
  expect(observed.ok).toBe(true)
  delete session.tabsByWorktree[childId]
  delete meta[childId]
  changed()
  expect(observed.isCurrent?.()).toBe(false)
  runtime.raw.mockResolvedValue({ ok: false, worktrees: [] })
  meta['r::/survivor'] = storeWorktreeMeta({
    hostId: 'local',
    displayName: 'Current name',
    instanceId: 'survivor'
  })
  changed()
  const writes = vi.spyOn(store, 'setWorktreeMeta')
  writes.mockClear()
  const current = await runtime.rows()
  expect(current.worktrees.map((row) => row.id)).toEqual(['r::/survivor'])
  expect(current.worktrees[0]?.displayName).toBe('Current name')
  expect(writes).not.toHaveBeenCalled()
})

it('surviving runtime joiners own the entire tail; last-owner timeout stops later Git admission and permits a successor', async () => {
  const { store } = fixture()
  const runtime = new Runtime(store)
  const head = Promise.withResolvers<{ stdout: string; stderr: string }>()
  gitRead.mockReturnValueOnce(head.promise)
  const departed = new AbortController()
  const first = runtime.listing(repo, departed.signal)
  const second = runtime.listing()
  await vi.waitFor(() => expect(gitRead).toHaveBeenCalledTimes(1))
  departed.abort()
  expect((await first).ok).toBe(false)
  head.resolve({ stdout: `\n${oid}\n`, stderr: '' })
  expect((await second).ok).toBe(true)
  expect(gitRead).toHaveBeenCalledTimes(2)
  expect((await runtime.listing()).ok).toBe(true)
  expect(gitRead).toHaveBeenCalledTimes(2)

  const timeoutRuntime = new Runtime(store)
  const stuckHead = Promise.withResolvers<{ stdout: string; stderr: string }>()
  gitRead.mockReset().mockReturnValueOnce(stuckHead.promise)
  vi.useFakeTimers()
  const pending = scanRepoWorktreeRows(
    { store, scanRepo: (repo, _runtimes, signal) => timeoutRuntime.listing(repo, signal) },
    repo,
    new Map()
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(gitRead).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(5000)
  expect((await pending).ok).toBe(false)
  stuckHead.resolve({ stdout: `\n${oid}\n`, stderr: '' })
  await vi.advanceTimersByTimeAsync(0)
  expect(gitRead).toHaveBeenCalledTimes(1)
  gitRead.mockImplementation(async (args: string[]) => ({
    stdout: args.includes('--show-prefix') ? `\n${oid}\n` : 'refs/heads/feature',
    stderr: ''
  }))
  expect((await timeoutRuntime.listing()).ok).toBe(true)
})

it('rejects a late retained read after actual background Delete settlement and owning-host cleanup', async () => {
  const state = getDefaultPersistedState('/tmp/pr36536-delete-fixture')
  state.repos = [repo]
  state.workspaceSession = { ...getDefaultWorkspaceSession(), tabsByWorktree: { [childId]: [] } }
  state.worktreeMeta[childId] = storeWorktreeMeta({ hostId: 'local', linkedPR: 42 })
  const store = new Store({
    dataFile: '/tmp/pr36536-delete-fixture/state.json',
    serializedState: JSON.stringify(state)
  })
  const detached = registerWorktreeChangeInvalidator(invalidateDetectedWorktreeScanCache)
  const late = Promise.withResolvers<{ stdout: string; stderr: string }>()
  gitRead.mockReturnValueOnce(late.promise)
  const listing = listDetectedWorktreesForCapturedRepo(store, repo, () => true)
  await vi.waitFor(() => expect(gitRead).toHaveBeenCalledTimes(1))
  try {
    await startBackgroundWorktreeRemoval({
      removal: {
        worktreeId: childId,
        repoId: repo.id,
        repoPath: repo.path,
        worktree: row(child),
        deleteBranch: false,
        force: false
      },
      run: async () => {
        removeWorktreeMetaRow(store, childId, 'local')
        return {}
      },
      publish: () => invalidateDetectedWorktreeScanCache(repo.id)
    })
    await _settlePendingWorktreeRemovalsForTests()
    expect(pendingWorktreeRemovals.size).toBe(0)
    expect(store.getAllWorktreeMetaForHost('local')[childId]).toBeUndefined()
    expect(knownWorktreeInventory(store).read(repo).paths).toEqual([])
    late.resolve({ stdout: `\n${oid}\n`, stderr: '' })
    expect(await listing).toMatchObject({
      authoritative: true,
      worktrees: [expect.objectContaining({ path: repo.path })]
    })
    expect(gitRead).toHaveBeenCalledTimes(1)
    expect(store.getAllWorktreeMetaForHost('local')[childId]).toBeUndefined()
    expect(failedWorktreeRemovals.size).toBe(0)
  } finally {
    detached()
    late.resolve({ stdout: `\n${oid}\n`, stderr: '' })
    await listing
  }
})

it('bounds host census, removal inventory, and complete cached observations at N and 10N on a real-scale corpus', async () => {
  const results: unknown[] = []
  for (const n of [100, 1000]) {
    __resetDetectedWorktreeScanCacheForTests()
    const repos = Array.from({ length: n }, (_, i) => ({
      ...repo,
      id: `repo-${i}`,
      path: `/repos/${i}`
    }))
    const { store, session, meta, changed } = fixture(repos, [])
    let metaVisits = 0,
      sessionVisits = 0,
      removalVisits = 0
    let projectVisits = 0,
      projectBatchVisits = 0
    const projects = repos.map((entry) => {
      const project = storeProject({ id: entry.id, sourceRepoIds: [entry.id] })
      Object.defineProperty(project, 'sourceRepoIds', {
        get: () => {
          projectVisits++
          return [entry.id]
        }
      })
      return project
    })
    const projectIterator = projects[Symbol.iterator].bind(projects)
    projects[Symbol.iterator] = function* () {
      for (const project of projectIterator()) {
        projectBatchVisits++
        yield project
      }
    }
    store.getProjects = () => projects
    for (const entry of repos) {
      const id = `${entry.id}::${entry.path}/child`
      meta[id] = storeWorktreeMeta({
        ...getProjectHostSetupWorktreeMeta([], entry),
        instanceId: id
      })
      meta[`${entry.id}::${entry.path}`] = storeWorktreeMeta({
        ...getProjectHostSetupWorktreeMeta([], entry),
        instanceId: entry.id
      })
      session.tabsByWorktree[id] = []
    }
    store.getAllWorktreeMetaForHost = () =>
      new Proxy(meta, {
        ownKeys(target) {
          const keys = Reflect.ownKeys(target)
          metaVisits += keys.length
          return keys
        }
      })
    session.tabsByWorktree = new Proxy(session.tabsByWorktree, {
      ownKeys(target) {
        const keys = Reflect.ownKeys(target)
        sessionVisits += keys.length
        return keys
      }
    })
    const originalValues = failedWorktreeRemovals.values.bind(failedWorktreeRemovals)
    const values = vi.spyOn(failedWorktreeRemovals, 'values').mockImplementation(function* () {
      for (const record of originalValues()) {
        removalVisits++
        yield record
      }
    })
    for (let i = 0; i < n; i++) {
      failedWorktreeRemovals.set(`history-${i}`, {
        worktreeId: `history-${i}`,
        repoId: 'unrelated',
        repoPath: '/other',
        worktreePath: `/other/${i}`,
        head: oid,
        branch: 'feature',
        deleteBranch: false,
        force: false,
        requestedAt: i
      })
    }
    rawScan.mockImplementation(async (entry: Repo) => [
      { ...row(entry.path), isMainWorktree: true },
      row(`${entry.path}/child`)
    ])
    statProbe.mockClear()
    realpathProbe.mockClear()
    gitRead.mockClear()
    rawScan.mockClear()
    const started = performance.now()
    for (const entry of repos) {
      expect(await listDetectedWorktreesForCapturedRepo(store, entry, () => true)).toMatchObject({
        authoritative: true
      })
    }
    expect(metaVisits).toBe(2 * n)
    expect(sessionVisits).toBe(n)
    expect(projectBatchVisits).toBe(n)
    expect(statProbe).not.toHaveBeenCalled()
    expect(realpathProbe).not.toHaveBeenCalled()
    expect(gitRead).not.toHaveBeenCalled()
    const target = repos[0]!
    // An unrelated localized owner change rebuilds one host census, preserving all other repo scopes.
    session.tabsByWorktree['repo-0::/new-owner'] = []
    changed()
    await listDetectedWorktreesForCapturedRepo(store, repos[1]!, () => true)
    expect(metaVisits).toBe(4 * n)
    expect(sessionVisits).toBe(2 * n + 1)
    delete session.tabsByWorktree['repo-0::/new-owner']
    changed()
    for (let i = 1; i < n; i++) {
      const id = `${target.id}::${target.path}/omitted-${i}`
      session.tabsByWorktree[id] = []
      meta[id] = storeWorktreeMeta({
        ...getProjectHostSetupWorktreeMeta([], target),
        instanceId: id
      })
    }
    changed()
    invalidateDetectedWorktreeScanCache(target.id)
    rawScan.mockImplementation(async (entry: Repo) => [
      { ...row(entry.path), isMainWorktree: true }
    ])
    const beforeRemoval = removalVisits
    const cold = await Promise.all(
      Array.from({ length: 8 }, () =>
        listDetectedWorktreesForCapturedRepo(store, target, () => true)
      )
    )
    expect(
      cold.every((result) => result && 'authoritative' in result && result.authoritative)
    ).toBe(true)
    const statCount = statProbe.mock.calls.length,
      realpathCount = realpathProbe.mock.calls.length,
      gitCount = gitRead.mock.calls.length
    expect([statCount, realpathCount, gitCount]).toEqual([n, n + 1, 2 * n])
    // Membership and removal composition each traverse history once, not once per joined caller/candidate.
    expect(removalVisits - beforeRemoval).toBe(3 * n)
    for (let k = 0; k < 8; k++) {
      await listDetectedWorktreesForCapturedRepo(store, target, () => true)
    }
    expect([
      statProbe.mock.calls.length,
      realpathProbe.mock.calls.length,
      gitRead.mock.calls.length
    ]).toEqual([statCount, realpathCount, gitCount])
    expect(removalVisits - beforeRemoval).toBe(3 * n)
    invalidateDetectedWorktreeScanCache(target.id)
    rawScan.mockResolvedValue([])
    const empty = await listDetectedWorktreesForCapturedRepo(store, target, () => true)
    expect(empty).toMatchObject({ authoritative: false, worktrees: [] })
    expect([
      statProbe.mock.calls.length,
      realpathProbe.mock.calls.length,
      gitRead.mock.calls.length
    ]).toEqual([statCount, realpathCount, gitCount])
    expect(projectBatchVisits).toBe(n)
    results.push({
      n,
      projectBatchVisits,
      existingProjectLookupVisits: projectVisits - projectBatchVisits,
      metaVisits,
      sessionVisits,
      removalVisits,
      rawScans: rawScan.mock.calls.length,
      retained: { statCount, realpathCount, gitCount },
      elapsedMs: performance.now() - started
    })
    values.mockRestore()
    failedWorktreeRemovals.clear()
  }
  if (process.env.ORCA_WORKTREE_BENCHMARK_REPORT) {
    await writeFile(process.env.ORCA_WORKTREE_BENCHMARK_REPORT, JSON.stringify(results, null, 2))
  }
})

it('never extends a completed proof on cache hits or old raw fingerprints', async () => {
  const { store } = fixture()
  const runtime = new Runtime(store)
  vi.useFakeTimers()
  expect((await runtime.listing()).ok).toBe(true)
  expect(statProbe).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(29_000)
  expect((await runtime.listing()).ok).toBe(true)
  expect(statProbe).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1001)
  statProbe.mockImplementation(async (path) => {
    if (path === child || path === repo.path) {
      throw Object.assign(new Error('offline'), { code: 'ENOENT' })
    }
    return { isDirectory: () => true }
  })
  gitRead.mockRejectedValue(new Error('offline'))
  expect((await runtime.listing()).ok).toBe(false)
  expect(statProbe.mock.calls.map(([path]) => path)).toEqual([child, child, repo.path, '/work'])
  statProbe.mockResolvedValue({ isDirectory: () => true })
  gitRead.mockImplementation(async (args: string[]) => ({
    stdout: args.includes('--show-prefix') ? `\n${oid}\n` : 'refs/heads/feature',
    stderr: ''
  }))
  expect((await runtime.listing()).ok).toBe(true)
})

it('keeps physical filesystem slots occupied after logical timeouts and stops abandoned queue admissions', async () => {
  const { store } = fixture()
  const runtimes = [new Runtime(store), new Runtime(store), new Runtime(store)]
  const slots = [
    Promise.withResolvers<{ isDirectory: () => boolean }>(),
    Promise.withResolvers<{ isDirectory: () => boolean }>()
  ]
  statProbe
    .mockImplementationOnce(() => slots[0]!.promise)
    .mockImplementationOnce(() => slots[1]!.promise)
  vi.useFakeTimers()
  const pending = runtimes.map((runtime) => runtime.listing())
  await vi.advanceTimersByTimeAsync(0)
  expect(statProbe).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2001)
  expect((await Promise.all(pending)).every((result) => !result.ok)).toBe(true)
  const successor = new Runtime(store)
  const queued = successor.listing()
  await vi.advanceTimersByTimeAsync(0)
  expect(statProbe).toHaveBeenCalledTimes(2)
  slots.forEach((slot) => slot.resolve({ isDirectory: () => true }))
  await vi.advanceTimersByTimeAsync(0)
  expect((await queued).ok).toBe(true)
  expect(statProbe).toHaveBeenCalledTimes(3)
})

describe('owning-host retained catalog consumers', () => {
  useWorktreeAwarenessEnvironment(cliMocks)
  it('carries terminal, unified, browser and editor-only owners through catalog, selector, phone feed and the real CLI command', async () => {
    const paths = ['/terminal', '/unified', '/browser', '/editor']
    const state = getDefaultPersistedState('/tmp/pr36536-consumers-fixture')
    const remote: Repo = {
      ...repo,
      path: '/remote',
      executionHostId: 'ssh:other',
      connectionId: 'other'
    }
    state.settings.worktreeVisibilityDefaults = { external: 'show' }
    state.repos = [repo, remote]
    state.workspaceSession = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { 'r::/terminal': [] },
      unifiedTabs: { 'r::/unified': [] },
      browserTabsByWorktree: { 'r::/browser': [] },
      openFilesByWorktree: { 'r::/editor': [] }
    }
    state.workspaceSessionsByHostId = {
      'ssh:other': {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { 'r::/foreign-only': [], 'r::/terminal': [] }
      }
    }
    // Sessions supply membership; metadata supplies the user-facing names and review context.
    for (const path of paths) {
      state.worktreeMeta[`r::${path}`] = storeWorktreeMeta({
        ...getProjectHostSetupWorktreeMeta([], repo),
        hostId: 'local',
        instanceId: path,
        displayName: `Saved ${path}`,
        linkedPR: 42
      })
    }
    const store = new Store({
      dataFile: '/tmp/pr36536-consumers-fixture/state.json',
      serializedState: JSON.stringify(state)
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: 'r::/terminal', hostId: 'ssh:other' }), {
      displayName: 'Other host',
      instanceId: 'remote'
    })
    const local = knownWorktreeInventory(store).read(repo)
    expect(local.paths.map((row) => [row.path, row.hasSession])).toEqual(
      [...paths].sort().map((path) => [path, true])
    )
    expect(
      knownWorktreeInventory(store)
        .read(remote)
        .paths.map((row) => row.path)
    ).toEqual(['/foreign-only', '/terminal'])
    const runtime = new Runtime(store)
    runtime.raw.mockImplementation(async (target) =>
      target.path === repo.path ? { ok: true, worktrees: [row()] } : { ok: false, worktrees: [] }
    )
    const snapshot = await runtime.rows()
    for (const path of paths) {
      expect(snapshot.worktrees).toContainEqual(
        expect.objectContaining({
          id: `r::${path}`,
          hostId: 'local',
          displayName: `Saved ${path}`,
          linkedPR: 42,
          branch: 'refs/heads/feature'
        })
      )
    }
    expect(snapshot.worktrees.some((row) => row.path === '/foreign-only')).toBe(false)
    expect(await runtime.scoped('r::/editor')).toMatchObject({
      hostId: 'local',
      displayName: 'Saved /editor',
      linkedPR: 42
    })
    const feed = runtime.sidebarInputsFeed
    if (!feed) {
      throw new Error('missing phone feed')
    }
    const phone = new TestPhone(feed, 'retained-catalog-phone')
    try {
      phone.refresh()
      await phone.settle()
      const installed = phone.state.installed
      if (!installed) {
        throw new Error('phone did not hydrate')
      }
      const domains = readSidebarFeedDomains(installed)
      const phoneRows = [...domains.workspaces.entries()]
        .map(([key, value]) => readFeedWorkspaceRow(key, value))
        .filter((row) => row !== null)
      for (const path of paths) {
        expect(phoneRows).toContainEqual(
          expect.objectContaining({
            worktree: expect.objectContaining({
              id: `r::${path}`,
              hostId: 'local',
              displayName: `Saved ${path}`,
              branch: 'refs/heads/feature',
              linkedPR: 42
            })
          })
        )
      }
      cliMocks.callMock.mockImplementation(async (method: string) => {
        if (method !== 'worktree.list') {
          throw new Error(`unexpected method ${method}`)
        }
        return okFixture('req-retained', await runtime.listManagedWorktrees(undefined, 10_000))
      })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        await cliMain(['worktree', 'list', '--json'], '/repo')
        const output = String(log.mock.calls[0]?.[0])
        for (const path of paths) {
          expect(output).toContain(`Saved ${path}`)
        }
        expect(output).toContain('Other host')
        expect(cliMocks.callMock).toHaveBeenCalledOnce()
      } finally {
        log.mockRestore()
      }
    } finally {
      phone.disconnect()
    }
  })
})

it('bounds the added removal index across omitted repos and unrelated history independently, and skips absent physical work', async () => {
  const results: unknown[] = []
  for (const [r, d] of [
    [100, 100],
    [100, 1000],
    [1000, 100],
    [1000, 1000]
  ] as const) {
    __resetDetectedWorktreeScanCacheForTests()
    failedWorktreeRemovals.clear()
    const repos = Array.from({ length: r }, (_, i) => ({
      ...repo,
      id: `omitted-${i}`,
      path: `/omitted/${i}`
    }))
    const { store, meta, changed } = fixture(repos, [])
    for (const entry of repos) {
      meta[`${entry.id}::${entry.path}/child`] = storeWorktreeMeta({
        hostId: 'local',
        instanceId: `${entry.id}::${entry.path}/child`
      })
      meta[`${entry.id}::${entry.path}`] = storeWorktreeMeta({
        hostId: 'local',
        instanceId: `${entry.id}::${entry.path}`
      })
    }
    changed()
    for (let i = 0; i < d; i++) {
      failedWorktreeRemovals.set(`history-${i}`, {
        worktreeId: `history-${i}`,
        repoId: 'other',
        repoPath: '/other',
        worktreePath: `/other/${i}`,
        branch: 'feature',
        head: oid,
        force: false,
        deleteBranch: false,
        requestedAt: i
      })
    }
    let addedMembershipVisits = 0,
      baselineCompositionVisits = 0
    const original = failedWorktreeRemovals.values.bind(failedWorktreeRemovals)
    const visits = vi.spyOn(failedWorktreeRemovals, 'values').mockImplementation(function* () {
      const membership = new Error('removal census origin').stack?.includes(
        'worktreeRemovalPathsForRepo'
      )
      for (const record of original()) {
        if (membership) {
          addedMembershipVisits++
        } else {
          baselineCompositionVisits++
        }
        yield record
      }
    })
    rawScan.mockImplementation(async (entry: Repo) => [
      { ...row(entry.path), isMainWorktree: true }
    ])
    gitRead.mockClear()
    realpathProbe.mockClear()
    statProbe.mockClear()
    const started = performance.now()
    for (const entry of repos) {
      expect(await listDetectedWorktreesForCapturedRepo(store, entry, () => true)).toMatchObject({
        authoritative: true
      })
    }
    expect(addedMembershipVisits).toBe(d)
    expect(baselineCompositionVisits).toBe(2 * r * d)
    expect(statProbe).toHaveBeenCalledTimes(r)
    expect(gitRead).toHaveBeenCalledTimes(2 * r)
    expect(realpathProbe).toHaveBeenCalledTimes(2 * r) // one candidate and lazy main fallback, once per complete observation
    const before = [
      statProbe.mock.calls.length,
      gitRead.mock.calls.length,
      addedMembershipVisits,
      baselineCompositionVisits
    ]
    for (const entry of repos) {
      await listDetectedWorktreesForCapturedRepo(store, entry, () => true)
    }
    expect([
      statProbe.mock.calls.length,
      gitRead.mock.calls.length,
      addedMembershipVisits,
      baselineCompositionVisits
    ]).toEqual(before)
    results.push({
      omittedRepos: r,
      unrelatedHistory: d,
      addedMembershipVisits,
      baselineCompositionVisits,
      stats: statProbe.mock.calls.length,
      checkoutReads: gitRead.mock.calls.length,
      realpaths: realpathProbe.mock.calls.length,
      elapsedMs: performance.now() - started
    })
    visits.mockRestore()
  }
  failedWorktreeRemovals.clear()
  for (const w of [100, 1000]) {
    __resetDetectedWorktreeScanCacheForTests()
    const { store } = fixture()
    rawScan.mockResolvedValue([row(), ...Array.from({ length: w }, (_, i) => row(`/raw/${i}`))])
    statProbe.mockImplementation(async (path) => {
      if (path === child) {
        throw Object.assign(new Error('absent'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true }
    })
    realpathProbe.mockClear()
    gitRead.mockClear()
    expect(await listDetectedWorktreesForCapturedRepo(store, repo, () => true)).toMatchObject({
      authoritative: true
    })
    expect(realpathProbe).not.toHaveBeenCalled()
    expect(gitRead).not.toHaveBeenCalled()
    // Positive alias uses a single necessary realpath and the raw precise index, independent of W.
    invalidateDetectedWorktreeScanCache(repo.id)
    statProbe.mockResolvedValue({ isDirectory: () => true })
    realpathProbe.mockImplementation(async (path) => (path === child ? '/raw/0' : path))
    expect(await listDetectedWorktreesForCapturedRepo(store, repo, () => true)).toMatchObject({
      authoritative: true,
      worktrees: expect.arrayContaining([expect.objectContaining({ path: child })])
    })
    expect(realpathProbe).toHaveBeenCalledTimes(1)
    expect(gitRead).not.toHaveBeenCalled()
    results.push({
      rawRows: w,
      absentRealpaths: 0,
      presentAliasRealpaths: realpathProbe.mock.calls.length
    })
  }
  if (process.env.ORCA_WORKTREE_OMISSION_REPORT) {
    await writeFile(process.env.ORCA_WORKTREE_OMISSION_REPORT, JSON.stringify(results, null, 2))
  }
})
