import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  ensureAuthorizedRootsCache,
  getRegisteredWorktreeRootsRevision,
  invalidateAuthorizedRootsCache,
  resolveRegisteredWorktreePath
} from '../ipc/registered-worktree-roots-cache'
import { runProcess } from '../../shared/child-process/run-process'
import type { Repo } from '../../shared/repo-types'
import { OrcaRuntimeService } from './orca-runtime'
import { PROJECT_RUNTIME_METHODS } from './rpc/methods/project-runtime-rpc-methods'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'

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
  cachedCatalog() {
    return {
      resolved: this.resolvedWorktrees.peek(),
      scanKeys: [...this.worktreeScanCache.keys()]
    }
  }
}

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  invalidateAuthorizedRootsCache()
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

describe('runtime project setup deletion and cache ownership', () => {
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
})
