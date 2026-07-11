/**
 * Task 3 (WSL native project support): `Project.defaultShell` self-erases unless
 * every persistence/merge/zod carve-out that already carries
 * `localWindowsRuntimePreference` also carries `defaultShell`. These tests prove
 * each site keeps the field instead of silently dropping it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import type { PersistedState, Project, ProjectHostSetup, Repo } from '../shared/types'
import { getDefaultPersistedState } from '../shared/constants'
import { buildRegistry } from './runtime/rpc/core'

// Shared mutable state so the electron mock can reference a per-test directory
const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

/** Reset modules and dynamically import Store so the data-file path picks up the current testState.dir */
async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

function writeDataFile(data: unknown): void {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(dataFile(), JSON.stringify(data, null, 2), 'utf-8')
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#737373',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const makeProjectHostSetup = (overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup => ({
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

describe('Project.defaultShell persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('Store.updateProject persists a project default shell across reload', async () => {
    const project = makeProject({ id: 'project-1', sourceRepoIds: ['r1'] })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      projects: [project],
      projectHostSetups: [
        makeProjectHostSetup({ id: 'setup-1', projectId: project.id, repoId: '' })
      ]
    })
    const store = await createStore()

    const updated = store.updateProject('project-1', { defaultShell: 'powershell' })

    expect(updated?.defaultShell).toBe('powershell')
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getProjects()[0]?.defaultShell).toBe('powershell')
  })

  it('projection resync (updateRepo) preserves an existing project default shell', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', upstream: { owner: 'stablyai', repo: 'orca' } }))

    store.updateProject('github:stablyai/orca', { defaultShell: 'cmd' })

    // Triggers Store#syncProjectHostSetupCompatibilityState, which re-derives
    // projects from repos via mergeProjectHostSetupCompatibilityState. This is
    // the projection-sync path the field previously self-erased through.
    store.updateRepo('r1', { displayName: 'renamed' })

    const project = store.getProjects().find((entry) => entry.id === 'github:stablyai/orca')
    expect(project?.defaultShell).toBe('cmd')
  })

  it('rebuildRepoBackedProjectState (profile transfer) preserves an existing project default shell', async () => {
    const { rebuildRepoBackedProjectState } =
      await import('./orca-profiles/profile-project-state-file')
    const repo = makeRepo({ id: 'r1', upstream: { owner: 'stablyai', repo: 'orca' } })
    const existingProject = makeProject({ id: 'github:stablyai/orca', defaultShell: 'git-bash' })
    const state: PersistedState = {
      ...getDefaultPersistedState(homedir()),
      repos: [repo],
      projects: [existingProject],
      projectHostSetups: []
    }

    const rebuilt = rebuildRepoBackedProjectState(state)

    const project = rebuilt.projects.find((entry) => entry.id === 'github:stablyai/orca')
    expect(project?.defaultShell).toBe('git-bash')
  })

  it('ProjectUpdate RPC schema (runtime.project.update) accepts defaultShell', async () => {
    const { PROJECT_RUNTIME_METHODS } =
      await import('./runtime/rpc/methods/project-runtime-rpc-methods')
    const registry = buildRegistry(PROJECT_RUNTIME_METHODS)
    const method = registry.get('project.update')
    expect(method).toBeDefined()

    const parsed = method!.params!.parse({
      projectId: 'project-1',
      updates: { defaultShell: 'powershell' }
    }) as { updates: { defaultShell?: string } }

    expect(parsed.updates.defaultShell).toBe('powershell')
  })
})
