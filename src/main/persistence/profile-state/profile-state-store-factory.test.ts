import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openProfileStateDatabase, profileStateDatabaseFile } from './profile-state-database'
import {
  createProfileStateStore as createProfileStateStoreImpl,
  type ProfileStateStoreFactoryOptions
} from './profile-state-store-factory'
import { getRepoMainWorktreeId } from '../../../shared/worktree/id'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').slice('encrypted:'.length)
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const temporaryDirectories: string[] = []
const storesToClose: ReturnType<typeof createProfileStateStoreImpl>['store'][] = []

function createProfileStateStore(
  options: ProfileStateStoreFactoryOptions
): ReturnType<typeof createProfileStateStoreImpl> {
  const result = createProfileStateStoreImpl(options)
  storesToClose.push(result.store)
  return result
}

afterEach(async () => {
  vi.restoreAllMocks()
  const openedStores = storesToClose.splice(0)
  for (const store of openedStores) {
    store.freezeWrites()
  }
  for (const store of openedStores) {
    await store.flushAsync()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createOptions(): ProfileStateStoreFactoryOptions & { directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-profile-state-store-factory-'))
  temporaryDirectories.push(root)
  const directory = join(root, 'profiles', 'profile-factory-test')
  mkdirSync(directory, { recursive: true })
  return {
    directory,
    dataFile: join(directory, 'orca-data.json'),
    databaseFile: profileStateDatabaseFile(directory),
    profileId: 'profile-factory-test'
  }
}

describe('initial desktop workspace authority admission', () => {
  it('initializes a valid empty SQLite profile instead of falling back to legacy JSON', () => {
    const options = { ...createOptions(), initializeHomeWorkspace: true }
    const opened = openProfileStateDatabase(options.databaseFile, options.profileId)
    opened.db.close()

    const result = createProfileStateStore({ ...options })

    expect(result.backend).toBe('sqlite')
    expect(result.classification).toBe('sqlite-only')
    expect(result.store.getSettings()).toBeDefined()
    expect(result.store.getRepos()).toEqual([
      expect.objectContaining({ kind: 'folder', path: homedir() })
    ])
    result.store.updateSettings({ theme: 'dark' })
    result.store.flushOrThrow()

    const verifier = createProfileStateStore({ ...options })
    expect(verifier.store.getSettings().theme).toBe('dark')
  })

  it('initializes and restores Home only when desktop startup opts in', () => {
    const options = { ...createOptions(), initializeHomeWorkspace: true }
    const first = createProfileStateStore(options)
    const [home] = first.store.getRepos()

    expect(first.store.getRepos()).toHaveLength(1)
    expect(home).toMatchObject({ path: homedir(), kind: 'folder' })
    const worktreeId = getRepoMainWorktreeId(home)
    expect(first.store.getWorkspaceSession()).toMatchObject({
      activeRepoId: home.id,
      activeWorktreeId: worktreeId,
      activeWorkspaceKey: worktreeWorkspaceKey(worktreeId),
      activeWorkspaceExecutionHostId: 'local',
      activeTabId: null,
      tabsByWorktree: {}
    })
    first.store.flushOrThrow()
    first.store.freezeWrites()

    const restarted = createProfileStateStore(options)
    expect(restarted.store.getRepos()).toEqual([home])
    expect(restarted.store.getWorkspaceSession().activeWorktreeId).toBe(worktreeId)
    restarted.store.removeProjectForHost({ id: home.id })
    restarted.store.flushOrThrow()
    restarted.store.freezeWrites()

    expect(createProfileStateStore(options).store.getRepos()).toEqual([])
  })

  it('does not initialize Home in an existing empty document or generic host profile', () => {
    const imported = createOptions()
    writeFileSync(imported.dataFile, JSON.stringify({ repos: [] }))
    expect(
      createProfileStateStore({ ...imported, initializeHomeWorkspace: true }).store.getRepos()
    ).toEqual([])

    const generic = createOptions()
    const first = createProfileStateStore(generic)
    expect(first.store.getRepos()).toEqual([])
    first.store.flushOrThrow()
    first.store.freezeWrites()
    expect(
      createProfileStateStore({ ...generic, initializeHomeWorkspace: true }).store.getRepos()
    ).toEqual([])
  })
})
