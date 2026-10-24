import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import type { Project, ProjectHostSetup } from '../shared/project-types'
import type { Repo } from '../shared/repo-types'
import type { WorkspaceLineage, WorktreeLineage } from '../shared/worktree/lineage-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../shared/worktree/id'
import type { PersistedState } from '../shared/persisted-state-types'
import { getDefaultPersistedState } from '../shared/constants'
import type { SshRemotePtyLease } from '../shared/ssh-types'
import { hydrateWorktreeMetaAliasProjection } from './persistence/loading-store/worktree-meta-alias-projection'
import { Store } from './persistence/loading-store/store'
import { getDataFile, initDataPath } from './persistence/loading-store/user-data-path'
import type { StoreRuntimeOptions } from './persistence/loading-store/store-runtime-state'
import { ProfileStateSqliteAuthority } from './persistence/profile-state/profile-state-sqlite-authority'
import {
  openProfileStateDatabaseReadOnly,
  profileStateDatabaseFile
} from './persistence/profile-state/profile-state-database'
import { exportProfileStateJson } from './persistence/profile-state/profile-state-documents'

export { makeTerminalTab } from './persistence-session-fixtures'

export const testState = { dir: '' }
const stores = new Set<Store>()

class UnitTestProfileStateAuthority extends ProfileStateSqliteAuthority {
  // Worker backup coverage uses the dedicated real-worker fixtures.
  override scheduleBackup(): void {}
}

export function createSqliteTestStore(
  StoreConstructor: typeof Store,
  options: Omit<StoreRuntimeOptions, 'profileStateAuthority'> = {}
): Store {
  const path = options.dataFile ?? getDataFile()
  const databaseFile = profileStateDatabaseFile(dirname(path))
  mkdirSync(dirname(path), { recursive: true })
  const authority = new UnitTestProfileStateAuthority(databaseFile, 'persistence-test')
  try {
    if (!existsSync(databaseFile) && existsSync(path)) {
      authority.writeSerializedState(readFileSync(path))
    }
    const store = new StoreConstructor({
      ...options,
      dataFile: path,
      profileStateAuthority: authority
    })
    stores.add(store)
    return store
  } catch (error) {
    authority.close()
    throw error
  }
}

export function writePersistedStateJson(path: string, json: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const databaseFile = profileStateDatabaseFile(dirname(path))
  const authority = new UnitTestProfileStateAuthority(databaseFile, 'persistence-test')
  try {
    authority.writeSerializedState(Buffer.from(json))
  } finally {
    authority.close()
  }
}

export async function closeTestStores(): Promise<void> {
  const opened = [...stores]
  stores.clear()
  await Promise.all(opened.map((store) => store.freezeWritesAsync()))
}

export function readPersistedStateJson(path = dataFile(), profileId = 'persistence-test'): string {
  const databaseFile = profileStateDatabaseFile(dirname(path))
  if (!existsSync(databaseFile)) {
    return readFileSync(path, 'utf8')
  }
  const opened = openProfileStateDatabaseReadOnly(databaseFile, profileId)
  try {
    return exportProfileStateJson(opened.db)
  } finally {
    opened.db.close()
  }
}

export function createStore(options: Pick<StoreRuntimeOptions, 'paneShellPath'> = {}): Store {
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return createSqliteTestStore(Store, { ...options, dataFile: dataFile() })
}

/** Seed legacy relay leases before load; the store no longer creates them. */
export function createStoreWithSshRemotePtyLeases(
  leases: (Pick<SshRemotePtyLease, 'targetId' | 'ptyId' | 'state'> & Partial<SshRemotePtyLease>)[]
): Store {
  writeDataFile({ ...getDefaultPersistedState(testState.dir), sshRemotePtyLeases: leases })
  return createStore()
}

export async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  }
}

export function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

export function writeDataFile(data: unknown): void {
  mkdirSync(testState.dir, { recursive: true })
  const json = JSON.stringify(data, null, 2)
  if (existsSync(profileStateDatabaseFile(testState.dir))) {
    writePersistedStateJson(dataFile(), json)
    return
  }
  writeFileSync(dataFile(), json, 'utf-8')
}

/** Restore aliases omitted by serialization, as Store.load does; use readPersistedStateJson for raw state. */
export function readDataFile(): unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Store exports use PersistedState; this fixture reader restores only its omitted aliases.
  const parsed = JSON.parse(readPersistedStateJson()) as PersistedState
  hydrateWorktreeMetaAliasProjection(parsed)
  return parsed
}

export function symlinkDirectorySync(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

export function collectPropertyPaths(value: unknown, property: string, prefix = ''): string[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  const paths: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (key === property) {
      paths.push(path)
    }
    paths.push(...collectPropertyPaths(child, property, path))
  }
  return paths
}

export const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

/** Stored layouts require registered repos to survive loading. */
export function workspaceRepos(...worktreeIds: string[]): Repo[] {
  return [...new Set(worktreeIds.map(getRepoIdFromWorktreeId))].map((id) => makeRepo({ id }))
}

export function registerWorkspaceRepos(store: Store, ...worktreeIds: string[]): void {
  for (const repo of workspaceRepos(...worktreeIds)) {
    if (!store.getRepo(repo.id)) {
      store.addRepo(repo)
    }
  }
}

export const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#737373',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

export const makeProjectHostSetup = (
  overrides: Partial<ProjectHostSetup> = {}
): ProjectHostSetup => ({
  id: 'setup-1',
  projectId: 'project-1',
  hostId: 'local',
  repoId: '',
  path: '/repo',
  displayName: 'Project',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

export const makeWorktreeLineage = (overrides: Partial<WorktreeLineage> = {}): WorktreeLineage => ({
  worktreeId: 'r1::/path/child',
  worktreeInstanceId: 'child-instance',
  parentWorktreeId: 'r1::/path/parent',
  parentWorktreeInstanceId: 'parent-instance',
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 1,
  ...overrides
})

export const makeWorkspaceLineage = (
  overrides: Partial<WorkspaceLineage> = {}
): WorkspaceLineage => ({
  childWorkspaceKey: worktreeWorkspaceKey('r1::/path/child'),
  childInstanceId: 'child-instance',
  parentWorkspaceKey: folderWorkspaceKey('folder-1'),
  parentInstanceId: null,
  origin: 'cli',
  capture: { source: 'env-workspace', confidence: 'inferred' },
  createdAt: 1,
  ...overrides
})
