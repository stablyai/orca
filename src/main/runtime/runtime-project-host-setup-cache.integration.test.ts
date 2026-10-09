import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  ensureAuthorizedRootsCache,
  getRegisteredWorktreeRootsRevision,
  invalidateAuthorizedRootsCache,
  resolveRegisteredWorktreePath
} from '../ipc/registered-worktree-roots-cache'
import { runProcess } from '../../shared/child-process/run-process'
import type { Repo } from '../../shared/repo-types'
import type { ProviderRequestId } from '../../shared/detected-worktree-provider-contract'
import type { ProjectHostSetupUpdateArgs } from '../../shared/project-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanCache, RuntimeWorktreeScanRefresh } from './orca-runtime-core'
import { OrcaRuntimeService } from './orca-runtime'
import { PROJECT_RUNTIME_METHODS } from './rpc/methods/project-runtime-rpc-methods'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import {
  __resetDetectedWorktreeScanCacheForTests,
  listDetectedGitWorktrees
} from '../ipc/worktrees/listing/detected-worktree-scan-cache'
import { listHostQualifiedDetectedWorktrees } from '../ipc/worktrees/listing/host-qualified-worktree-listing'
import * as repoWorktrees from '../repo-worktrees'
import { getWorktreeScanMutationRevision } from '../local-worktree-scan-generation'
import { createCapturedRepoCurrentGuard } from '../ipc/worktrees/listing/worktree-host-ownership'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { manifest } from '../persistence-orcad-migration-catalog-fixture'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0',
    isPackaged: false,
    on: vi.fn(),
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

class CatalogRuntime extends OrcaRuntimeService {
  buildCatalogForTest() {
    return this.computeResolvedWorktrees()
  }

  cachedCatalog() {
    return {
      resolved: this.resolvedWorktrees.peek(),
      scanKeys: [...this.worktreeScanCache.keys()]
    }
  }
}

class PausedCatalogRuntime extends CatalogRuntime {
  private nextScan: {
    entered: ReturnType<typeof Promise.withResolvers<void>>
    released: ReturnType<typeof Promise.withResolvers<void>>
  } | null = null

  pauseNextScan() {
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    this.nextScan = { entered, released }
    return { entered: entered.promise, release: () => released.resolve() }
  }

  protected override async refreshRepoWorktreeScan(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined,
    cached: RuntimeWorktreeScanCache | null
  ): Promise<RuntimeWorktreeScanRefresh> {
    const gate = this.nextScan
    this.nextScan = null
    const result = await super.refreshRepoWorktreeScan(repo, projectRuntime, cached)
    if (gate) {
      gate.entered.resolve()
      await gate.released.promise
    }
    return result
  }
}

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  invalidateAuthorizedRootsCache()
  __resetDetectedWorktreeScanCacheForTests()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function openStore(): { store: Store; directory: string } {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-setup-cache-')))
  directories.push(directory)
  return {
    store: createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') }),
    directory
  }
}

function fixtureRepo(path: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-cache',
    path,
    kind: 'git',
    displayName: 'Project',
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: 'local',
    upstream: { owner: 'fixture', repo: 'setup' },
    gitRemoteIdentity: null,
    ...overrides
  }
}

async function createGitRepo(path: string): Promise<void> {
  mkdirSync(path)
  for (const args of [
    ['init', '-q'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'initial'
    ]
  ]) {
    const result = await runProcess({ program: 'git', args, cwd: path, timeoutMs: 10_000 })
    expect(result.code, result.stderr).toBe(0)
  }
}

function deleteSetup(runtime: OrcaRuntimeService, setupId: string) {
  const method = PROJECT_RUNTIME_METHODS.find(
    (candidate) => candidate.name === 'projectHostSetup.delete'
  )
  if (!method) {
    throw new Error('missing_project_setup_delete_method')
  }
  return method.handler(method.params.parse({ setupId }), { runtime }).result
}

function updateSetup(
  runtime: OrcaRuntimeService,
  updates: ProjectHostSetupUpdateArgs['updates'],
  setupId = 'repo-cache'
) {
  const method = PROJECT_RUNTIME_METHODS.find(
    (candidate) => candidate.name === 'projectHostSetup.update'
  )
  if (!method) {
    throw new Error('missing_project_setup_update_method')
  }
  return method.handler(method.params.parse({ setupId, updates }), { runtime }).result
}

async function createLinkedWorktree(path: string, linked: string): Promise<void> {
  const result = await runProcess({
    program: 'git',
    args: ['worktree', 'add', '-q', '-b', 'linked-fixture', linked],
    cwd: path,
    timeoutMs: 10_000
  })
  expect(result.code, result.stderr).toBe(0)
}

function currentRepo(store: Store): Repo {
  const repo = store.getRepo('repo-cache')
  if (!repo) {
    throw new Error('missing_fixture_repo')
  }
  return repo
}

function catalogPaths(rows: readonly { path: string }[]): string[] {
  return rows.map((row) => row.path.replaceAll('\\', '/')).sort()
}

function storedWorkspaceState(store: Store) {
  return structuredClone({
    metadata: store.getAllWorktreeMeta(),
    lineage: store.getAllWorktreeLineage(),
    workspaceLineage: store.getAllWorkspaceLineage()
  })
}

function listMainCatalog(
  store: Store,
  requestId: 'warm' | 'replacement' | 'old' | 'new' | 'new-cached'
) {
  return listHostQualifiedDetectedWorktrees(store, {
    repoId: 'repo-cache',
    executionHostId: 'local',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These fixed nonempty ASCII fixture correlation IDs are below the 128-byte limit.
    providerRequestId: requestId as ProviderRequestId
  })
}

describe('runtime project setup deletion and cache ownership', () => {
  it('hydrates the 100-owner folder fleet once while stamping and removing metadata', async () => {
    const { store, directory } = openStore()
    for (let index = 0; index < 100; index += 1) {
      const path = join(directory, `folder-${index}`)
      mkdirSync(path)
      store.addRepo(fixtureRepo(path, { id: `repo-${index}`, kind: 'folder', upstream: undefined }))
    }
    const runtime = new CatalogRuntime(store)
    const getRepos = vi.spyOn(store, 'getRepos')
    const revision = getWorktreeScanMutationRevision()
    const first = await runtime.buildCatalogForTest()
    expect(first.worktrees).toHaveLength(100)
    expect(first.worktrees.every((row) => row.instanceId)).toBe(true)
    expect(Object.keys(store.getAllWorktreeMeta())).toHaveLength(100)
    expect(getWorktreeScanMutationRevision()).toBe(revision)
    expect(getRepos).toHaveBeenCalledTimes(1)
    for (const row of first.worktrees) {
      store.removeWorktreeMeta(row.id, 'local')
    }
    getRepos.mockClear()
    expect((await runtime.buildCatalogForTest()).worktrees).toHaveLength(100)
    expect(getWorktreeScanMutationRevision()).toBe(revision)
    expect(getRepos).toHaveBeenCalledTimes(1)
  })

  it('refreshes the ownership index on Store catalog edits without rebuilding for metadata', () => {
    const { store, directory } = openStore()
    store.addRepo(fixtureRepo(join(directory, 'repo'), { kind: 'folder' }))
    const owners = store.getRepos()
    const original = owners[0]!
    const isCurrent = createCapturedRepoCurrentGuard(store, owners)
    const getRepos = vi.spyOn(store, 'getRepos')
    const worktreeId = `${original.id}::${original.path}`
    for (let index = 0; index < 100; index += 1) {
      store.setWorktreeMeta(worktreeId, { hostId: 'local', displayName: `row-${index}` })
      expect(isCurrent(original, 'local')).toBe(true)
    }
    store.removeWorktreeMeta(worktreeId, 'local')
    expect(isCurrent(original, 'local')).toBe(true)
    expect(getRepos).not.toHaveBeenCalled()
    const changed = store.updateRepo(original.id, { kind: 'git' })
    expect(changed).not.toBeNull()
    expect(isCurrent(original, 'local')).toBe(false)
    if (!changed) {
      throw new Error('missing_updated_fixture_repo')
    }
    expect(isCurrent(changed, 'local')).toBe(true)
    expect(getRepos).toHaveBeenCalledTimes(1)
    store.removeProjectForHost(original.id, 'local')
    expect(isCurrent(changed, 'local')).toBe(false)
    expect(getRepos).toHaveBeenCalledTimes(2)
    const replacement = { ...changed, addedAt: 2 }
    store.addRepo(replacement)
    expect(isCurrent(changed, 'local')).toBe(false)
    expect(isCurrent(replacement, 'local')).toBe(true)
    expect(getRepos).toHaveBeenCalledTimes(3)
  })

  it('admits a committed catalog import through an already warm ownership index', () => {
    const { store, directory } = openStore()
    const imported = fixtureRepo(join(directory, 'imported'), {
      kind: 'folder',
      executionHostId: 'ssh:source',
      connectionId: 'source'
    })
    const input = manifest({
      payload: { repositories: [imported], projectGroups: [], folderWorkspaces: [] }
    })
    const isCurrent = createCapturedRepoCurrentGuard(store, [])
    const getRepos = vi.spyOn(store, 'getRepos')
    store.stageOrcadMigrationCatalog(input)
    expect(isCurrent(imported, 'ssh:source')).toBe(false)
    expect(getRepos).not.toHaveBeenCalled()
    store.commitStagedOrcadMigrationCatalog(input)
    const local = currentRepo(store)
    expect(local.connectionId).toBeUndefined()
    expect(local.executionHostId).toBeUndefined()
    expect(isCurrent(local, 'local')).toBe(true)
    expect(getRepos).toHaveBeenCalledTimes(1)
    store.commitStagedOrcadMigrationCatalog(input)
    expect(isCurrent(local, 'local')).toBe(true)
    expect(getRepos).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])(
    'retires the raw SSH owner after target reassignment (%s)',
    (explicitHost) => {
      const { store, directory } = openStore()
      store.addRepo(
        fixtureRepo(join(directory, 'remote'), {
          connectionId: 'old',
          executionHostId: explicitHost ? 'ssh:old' : undefined
        })
      )
      const old = currentRepo(store)
      const isCurrent = createCapturedRepoCurrentGuard(store, [old])
      const getRepos = vi.spyOn(store, 'getRepos')
      expect(store.reassignSshTargetId('old', 'new')).toEqual(['repo-cache'])
      const current = currentRepo(store)
      expect(current.connectionId).toBe('new')
      expect(current.executionHostId).toBe(explicitHost ? 'ssh:new' : undefined)
      expect(isCurrent(old, 'ssh:old')).toBe(false)
      expect(isCurrent(current, 'ssh:new')).toBe(true)
      expect(getRepos).toHaveBeenCalledTimes(1)
      store.setWorktreeMeta(`${current.id}::${current.path}`, { hostId: 'ssh:new' })
      expect(isCurrent(current, 'ssh:new')).toBe(true)
      expect(getRepos).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps registration admission isolated between profile Store instances', () => {
    const first = openStore()
    const second = openStore()
    first.store.addRepo(fixtureRepo(join(first.directory, 'repo'), { kind: 'folder' }))
    second.store.addRepo(
      fixtureRepo(join(second.directory, 'repo'), { kind: 'folder', addedAt: 2 })
    )
    const firstRepo = currentRepo(first.store)
    const secondRepo = currentRepo(second.store)
    const firstCurrent = createCapturedRepoCurrentGuard(first.store, [firstRepo])
    const secondCurrent = createCapturedRepoCurrentGuard(second.store, [secondRepo])
    expect(firstCurrent(firstRepo, 'local')).toBe(true)
    expect(firstCurrent(secondRepo, 'local')).toBe(false)
    expect(secondCurrent(secondRepo, 'local')).toBe(true)
    expect(secondCurrent(firstRepo, 'local')).toBe(false)
  })

  it.each([
    ['local-first', 'local'],
    ['local-first', 'ssh:target-a'],
    ['ssh-first', 'local'],
    ['ssh-first', 'ssh:target-a']
  ] as const)('matches the admitted kind update host with %s and %s selected', (order, hostId) => {
    const { store, directory } = openStore()
    const local = fixtureRepo(join(directory, 'local'), {
      kind: hostId === 'local' ? 'git' : 'folder'
    })
    const remote = fixtureRepo(join(directory, 'remote'), {
      kind: hostId === 'ssh:target-a' ? 'git' : 'folder',
      executionHostId: 'ssh:target-a',
      connectionId: 'target-a'
    })
    for (const repo of order === 'local-first' ? [local, remote] : [remote, local]) {
      store.addRepo(repo)
    }
    // H2 owns qualified admission; its exact returned host must drive H1's cache retirement.
    vi.spyOn(store, 'updateProjectHostSetup').mockImplementation(({ updates }) => {
      const repo = store.updateRepo('repo-cache', { kind: updates.kind }, hostId)
      const setup = store.getProjectHostSetups().find((entry) => entry.hostId === hostId)
      const project = store.getProjects().find((entry) => entry.id === setup?.projectId)
      if (!repo || !setup || !project) {
        throw new Error('missing_admitted_fixture_setup')
      }
      return { repo, setup, project }
    })
    const invalidateResolvedWorktrees = vi.fn()
    const invalidateWorktreeScan = vi.fn()
    const notifyReposChanged = vi.fn()
    const controller = new RuntimeProjectHostSetupController({
      getStore: () => store,
      listRepos: () => store.getRepos(),
      addRepo: vi.fn(),
      addRemoteRepo: vi.fn(),
      cloneRepo: vi.fn(),
      invalidateResolvedWorktrees,
      invalidateWorktreeScan,
      notifyReposChanged
    })
    const result = controller.updateSetup({ setupId: 'repo-cache', updates: { kind: 'folder' } })
    expect(result.setup.hostId).toBe(hostId)
    expect(store.getRepos().map((repo) => [getRepoExecutionHostId(repo), repo.kind])).toEqual(
      order === 'local-first'
        ? [
            ['local', 'folder'],
            ['ssh:target-a', 'folder']
          ]
        : [
            ['ssh:target-a', 'folder'],
            ['local', 'folder']
          ]
    )
    expect(invalidateResolvedWorktrees).toHaveBeenCalledOnce()
    expect(invalidateWorktreeScan).toHaveBeenCalledExactlyOnceWith('repo-cache')
    expect(notifyReposChanged).toHaveBeenCalledOnce()
  })

  it('forgets warmed resolution, discovery, and authorization before the repo id is re-used', async () => {
    const { store, directory } = openStore()
    const oldPath = join(directory, 'old')
    const newPath = join(directory, 'new')
    await createGitRepo(oldPath)
    await createGitRepo(newPath)
    store.addRepo(fixtureRepo(oldPath))
    const runtime = new CatalogRuntime(store)
    expect(
      (await runtime.listManagedWorktrees('id:repo-cache')).worktrees.map((row) =>
        row.path.replaceAll('\\', '/')
      )
    ).toContain(oldPath.replaceAll('\\', '/'))
    const warmed = runtime.cachedCatalog()
    expect(warmed.resolved).not.toBeNull()
    expect(warmed.scanKeys).toEqual(['repo-cache\0local'])
    await ensureAuthorizedRootsCache(store)
    expect(await resolveRegisteredWorktreePath(oldPath, store)).toBe(oldPath)
    const authorizedRevision = getRegisteredWorktreeRootsRevision('repo-cache')
    const clientEvent = vi.fn()
    const unsub = runtime.onClientEvent(clientEvent)

    try {
      expect(deleteSetup(runtime, 'repo-cache').repo?.path).toBe(oldPath)
      expect(store.getRepos()).toEqual([])
      expect(runtime.cachedCatalog()).toEqual({ resolved: null, scanKeys: [] })
      expect(getRegisteredWorktreeRootsRevision('repo-cache')).toBeGreaterThan(authorizedRevision)
      await expect(resolveRegisteredWorktreePath(oldPath, store)).rejects.toThrow(
        'unknown repository'
      )
      expect(clientEvent.mock.calls).toEqual([[{ type: 'reposChanged' }]])

      store.addRepo(fixtureRepo(newPath))
      const managed = await runtime.listManagedWorktrees('id:repo-cache')
      expect(managed.worktrees.map((row) => row.path.replaceAll('\\', '/'))).toEqual([
        newPath.replaceAll('\\', '/')
      ])
      const detected = await runtime.listDetectedManagedWorktrees('id:repo-cache')
      expect(detected.worktrees.map((row) => row.path.replaceAll('\\', '/'))).toEqual([
        newPath.replaceAll('\\', '/')
      ])
    } finally {
      unsub()
    }
  })

  it('keeps unrelated repo caches when an independent setup is deleted', async () => {
    const { store, directory } = openStore()
    const path = join(directory, 'repo')
    await createGitRepo(path)
    store.addRepo(fixtureRepo(path))
    const runtime = new CatalogRuntime(store)
    await runtime.listManagedWorktrees('id:repo-cache')
    await ensureAuthorizedRootsCache(store)
    const warmed = runtime.cachedCatalog()
    const authorizedRevision = getRegisteredWorktreeRootsRevision('repo-cache')
    const project = store.getProjects()[0]!
    const created = runtime.createProjectHostSetup({
      projectId: project.id,
      hostId: 'ssh:target-a'
    })

    expect(deleteSetup(runtime, created.setup.id).repo).toBeUndefined()
    expect(runtime.cachedCatalog().resolved).toBe(warmed.resolved)
    expect(runtime.cachedCatalog().scanKeys).toEqual(warmed.scanKeys)
    expect(getRegisteredWorktreeRootsRevision('repo-cache')).toBe(authorizedRevision)
    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-cache'])
  })

  it('preserves the host-scoped rollback when linking a newly registered repo fails', async () => {
    const { store, directory } = openStore()
    const sibling = fixtureRepo(join(directory, 'remote'), {
      id: 'repo-remote',
      kind: 'folder',
      executionHostId: 'ssh:target-a'
    })
    const registered = fixtureRepo(join(directory, 'local'), { id: 'repo-new', kind: 'folder' })
    store.addRepo(sibling)
    const removeProjectForHost = vi.spyOn(store, 'removeProjectForHost')
    const notifyReposChanged = vi.fn()
    const invalidateResolvedWorktrees = vi.fn()
    const invalidateWorktreeScan = vi.fn()
    const controller = new RuntimeProjectHostSetupController({
      getStore: () => store,
      listRepos: () => store.getRepos(),
      addRepo: async () => {
        store.addRepo(registered)
        return registered
      },
      addRemoteRepo: vi.fn(),
      cloneRepo: vi.fn(),
      invalidateResolvedWorktrees,
      invalidateWorktreeScan,
      notifyReposChanged
    })
    const authorizedRevision = getRegisteredWorktreeRootsRevision(registered.id)

    await expect(
      controller.setupExistingFolder({
        projectId: 'github:someone/else',
        hostId: 'local',
        path: registered.path,
        kind: 'folder'
      })
    ).rejects.toThrow('Imported folder does not match')
    expect(removeProjectForHost).toHaveBeenCalledExactlyOnceWith(registered.id, 'local')
    expect(store.getRepos().map((repo) => repo.id)).toEqual([sibling.id])
    expect(invalidateResolvedWorktrees).toHaveBeenCalledOnce()
    expect(invalidateWorktreeScan).toHaveBeenCalledExactlyOnceWith(registered.id)
    expect(getRegisteredWorktreeRootsRevision(registered.id)).toBeGreaterThan(authorizedRevision)
    expect(notifyReposChanged).toHaveBeenCalledOnce()
  })

  it('retires linked Git authorization when a repo-backed setup becomes a folder', async () => {
    const { store, directory } = openStore()
    const path = join(directory, 'repo')
    const linked = join(directory, 'linked')
    await createGitRepo(path)
    await createLinkedWorktree(path, linked)
    store.addRepo(fixtureRepo(path, { externalWorktreeVisibility: 'show' }))
    const runtime = new CatalogRuntime(store)
    await runtime.listManagedWorktrees('id:repo-cache')
    await runtime.listDetectedManagedWorktrees('id:repo-cache')
    await listDetectedGitWorktrees(store, currentRepo(store))
    await ensureAuthorizedRootsCache(store)
    expect(await resolveRegisteredWorktreePath(linked, store)).toBe(linked)
    const revision = getRegisteredWorktreeRootsRevision('repo-cache')
    const clientEvent = vi.fn()
    const unsub = runtime.onClientEvent(clientEvent)
    try {
      expect(updateSetup(runtime, { kind: 'folder' }).repo?.kind).toBe('folder')
      expect(currentRepo(store).kind).toBe('folder')
      expect(runtime.cachedCatalog()).toEqual({ resolved: null, scanKeys: [] })
      expect(getRegisteredWorktreeRootsRevision('repo-cache')).toBeGreaterThan(revision)
      expect(clientEvent.mock.calls).toEqual([[{ type: 'reposChanged' }]])
      expect(catalogPaths((await runtime.listManagedWorktrees('id:repo-cache')).worktrees)).toEqual(
        catalogPaths([{ path }])
      )
      expect(
        catalogPaths((await runtime.listDetectedManagedWorktrees('id:repo-cache')).worktrees)
      ).toEqual(catalogPaths([{ path }]))
      await expect(resolveRegisteredWorktreePath(linked, store)).rejects.toThrow(
        'unknown repository'
      )
      expect(await resolveRegisteredWorktreePath(path, store)).toBe(path)
    } finally {
      unsub()
    }
  })

  it('re-lists the current Git graph after switching through folder mode', async () => {
    const { store, directory } = openStore()
    const path = join(directory, 'repo')
    const linked = join(directory, 'linked')
    await createGitRepo(path)
    store.addRepo(fixtureRepo(path, { externalWorktreeVisibility: 'show' }))
    const runtime = new CatalogRuntime(store)
    await runtime.listManagedWorktrees('id:repo-cache')
    await runtime.listDetectedManagedWorktrees('id:repo-cache')
    await listDetectedGitWorktrees(store, currentRepo(store))
    await ensureAuthorizedRootsCache(store)
    const clientEvent = vi.fn()
    const unsub = runtime.onClientEvent(clientEvent)
    try {
      updateSetup(runtime, { kind: 'folder' })
      expect(catalogPaths((await runtime.listManagedWorktrees('id:repo-cache')).worktrees)).toEqual(
        catalogPaths([{ path }])
      )
      await createLinkedWorktree(path, linked)
      updateSetup(runtime, { kind: 'git' })
      expect(runtime.cachedCatalog()).toEqual({ resolved: null, scanKeys: [] })
      expect(clientEvent.mock.calls).toEqual([
        [{ type: 'reposChanged' }],
        [{ type: 'reposChanged' }]
      ])
      const expected = catalogPaths([{ path }, { path: linked }])
      expect(catalogPaths((await runtime.listManagedWorktrees('id:repo-cache')).worktrees)).toEqual(
        expected
      )
      expect(
        catalogPaths((await runtime.listDetectedManagedWorktrees('id:repo-cache')).worktrees)
      ).toEqual(expected)
      expect(
        catalogPaths((await listDetectedGitWorktrees(store, currentRepo(store))).gitWorktrees)
      ).toEqual(expected)
      expect(await resolveRegisteredWorktreePath(linked, store)).toBe(linked)
    } finally {
      unsub()
    }
  })

  it('preserves warm caches for rejected, unchanged-kind, and independent setup updates', async () => {
    const { store, directory } = openStore()
    const path = join(directory, 'repo')
    const otherPath = join(directory, 'other')
    await createGitRepo(path)
    await createGitRepo(otherPath)
    store.addRepo(fixtureRepo(path))
    const runtime = new CatalogRuntime(store)
    await runtime.listManagedWorktrees('id:repo-cache')
    await ensureAuthorizedRootsCache(store)
    const warmed = runtime.cachedCatalog()
    const revision = getRegisteredWorktreeRootsRevision('repo-cache')
    const clientEvent = vi.fn()
    const unsub = runtime.onClientEvent(clientEvent)
    try {
      expect(() => updateSetup(runtime, { kind: 'folder', path: otherPath })).toThrow(
        'paths must be changed by re-importing'
      )
      expect(() => updateSetup(runtime, { kind: 'folder' }, 'missing')).toThrow('not found')
      expect(currentRepo(store).path).toBe(path)
      expect(currentRepo(store).kind).toBe('git')
      expect(clientEvent).not.toHaveBeenCalled()
      updateSetup(runtime, { kind: 'git' })
      const setup = runtime.createProjectHostSetup({
        projectId: store.getProjects()[0]!.id,
        hostId: 'ssh:target-a',
        kind: 'git'
      }).setup
      updateSetup(runtime, { kind: 'folder' }, setup.id)
      expect(runtime.cachedCatalog().resolved).toBe(warmed.resolved)
      expect(runtime.cachedCatalog().scanKeys).toEqual(warmed.scanKeys)
      expect(getRegisteredWorktreeRootsRevision('repo-cache')).toBe(revision)
      expect(clientEvent).toHaveBeenCalledTimes(3)
      expect(await resolveRegisteredWorktreePath(path, store)).toBe(path)
      await expect(resolveRegisteredWorktreePath(otherPath, store)).rejects.toThrow(
        'unknown repository'
      )
    } finally {
      unsub()
    }
  })

  it.each(['kind change', 'replacement'])(
    'rejects an old runtime Git completion after a setup %s',
    async (mutation) => {
      const { store, directory } = openStore()
      const oldPath = join(directory, 'old')
      const newPath = join(directory, 'new')
      const linked = join(directory, 'linked')
      await createGitRepo(oldPath)
      await createGitRepo(newPath)
      await createLinkedWorktree(newPath, linked)
      store.addRepo(fixtureRepo(oldPath, { externalWorktreeVisibility: 'show' }))
      const runtime = new PausedCatalogRuntime(store)
      const gate = runtime.pauseNextScan()
      const pending = runtime.listManagedWorktrees('id:repo-cache')
      try {
        await gate.entered
        if (mutation === 'replacement') {
          deleteSetup(runtime, 'repo-cache')
          store.addRepo(fixtureRepo(newPath, { addedAt: 2, externalWorktreeVisibility: 'show' }))
        } else {
          updateSetup(runtime, { kind: 'folder' })
        }
        const current = await new CatalogRuntime(store).listManagedWorktrees('id:repo-cache')
        if (mutation === 'replacement') {
          const parent = current.worktrees.find((row) => row.isMainWorktree)
          const child = current.worktrees.find((row) => !row.isMainWorktree)
          if (!parent?.instanceId || !child?.instanceId) {
            throw new Error('missing_current_lineage_instances')
          }
          store.setWorktreeLineage(child.id, {
            worktreeId: child.id,
            worktreeInstanceId: child.instanceId,
            parentWorktreeId: parent.id,
            parentWorktreeInstanceId: parent.instanceId,
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: 1
          })
        }
        const admitted = storedWorkspaceState(store)
        await store.flush()
        const persisted = readPersistedStateJson(join(directory, 'orca-data.json'))
        gate.release()
        const stale = await pending
        expect(storedWorkspaceState(store)).toEqual(admitted)
        await store.flush()
        expect(readPersistedStateJson(join(directory, 'orca-data.json'))).toBe(persisted)
        expect(stale.worktrees).toEqual([])
        expect(runtime.cachedCatalog().resolved).toBeNull()
        expect(
          catalogPaths((await runtime.listDetectedManagedWorktrees('id:repo-cache')).worktrees)
        ).toEqual(catalogPaths(current.worktrees))
      } finally {
        gate.release()
        await pending
      }
    }
  )

  it.each(['different path', 'same path'])(
    'retires a main-process warm scan when the registration is re-added at the %s',
    async (replacement) => {
      const { store, directory } = openStore()
      const oldPath = join(directory, 'old')
      const newPath = replacement === 'same path' ? oldPath : join(directory, 'new')
      const linked = join(directory, 'linked')
      await createGitRepo(oldPath)
      if (newPath !== oldPath) {
        await createGitRepo(newPath)
      }
      store.addRepo(fixtureRepo(oldPath, { externalWorktreeVisibility: 'show' }))
      expect((await listMainCatalog(store, 'warm')).status).toBe('complete')
      store.deleteProjectHostSetup({ setupId: 'repo-cache' })
      await createLinkedWorktree(newPath, linked)
      store.addRepo(fixtureRepo(newPath, { addedAt: 2, externalWorktreeVisibility: 'show' }))
      const result = await listMainCatalog(store, 'replacement')
      if (result.status !== 'complete') {
        throw new Error('current_main_catalog_not_complete')
      }
      expect(catalogPaths(result.result.worktrees)).toEqual(
        catalogPaths([{ path: newPath }, { path: linked }])
      )
    }
  )

  it('rejects an old main-process native Git completion while admitting the replacement', async () => {
    const { store, directory } = openStore()
    const oldPath = join(directory, 'old')
    const newPath = join(directory, 'new')
    const linked = join(directory, 'linked')
    await createGitRepo(oldPath)
    await createGitRepo(newPath)
    await createLinkedWorktree(newPath, linked)
    store.addRepo(fixtureRepo(oldPath, { externalWorktreeVisibility: 'show' }))
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const actualList = repoWorktrees.listRepoWorktreesForDetectedScan
    const scan = vi.spyOn(repoWorktrees, 'listRepoWorktreesForDetectedScan')
    scan.mockImplementationOnce(async (...args) => {
      const rows = await actualList(...args)
      entered.resolve()
      await released.promise
      return rows
    })
    const pending = listMainCatalog(store, 'old')
    let replacement: ReturnType<typeof listMainCatalog> | undefined
    try {
      await entered.promise
      store.deleteProjectHostSetup({ setupId: 'repo-cache' })
      store.addRepo(fixtureRepo(newPath, { addedAt: 2, externalWorktreeVisibility: 'show' }))
      replacement = listMainCatalog(store, 'new')
      await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2))
      const current = await replacement
      expect(current.status).toBe('complete')
      const admitted = storedWorkspaceState(store)
      released.resolve()
      expect((await pending).status).toBe('stale')
      expect(storedWorkspaceState(store)).toEqual(admitted)
      const cached = await listMainCatalog(store, 'new-cached')
      if (cached.status !== 'complete') {
        throw new Error('replacement_cache_not_complete')
      }
      expect(catalogPaths(cached.result.worktrees)).toEqual(
        catalogPaths([{ path: newPath }, { path: linked }])
      )
      expect(scan).toHaveBeenCalledTimes(2)
      await expect(resolveRegisteredWorktreePath(oldPath, store)).rejects.toThrow(
        'unknown repository'
      )
    } finally {
      released.resolve()
      await pending
      await replacement
    }
  })
})
