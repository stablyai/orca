import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../shared/constants'
import {
  testState,
  createStore,
  writeDataFile,
  makeRepo,
  makeProject,
  makeProjectHostSetup
} from './persistence-test-harness'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

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

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('preserves a repo-backed project Herdr session name through projection reload', async () => {
    const repo = makeRepo({ id: 'r1', path: '/repo', displayName: 'Repo' })
    const project = makeProject({
      id: 'repo:r1',
      sourceRepoIds: ['r1'],
      herdrSessionName: 'orca-repo-session'
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [repo],
      projects: [project],
      projectHostSetups: []
    })

    const store = await createStore()

    expect(store.getProjects()[0]?.herdrSessionName).toBe('orca-repo-session')
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getProjects()[0]?.herdrSessionName).toBe('orca-repo-session')
  })

  it('persists the desired and active terminal backend per execution host', async () => {
    const project = makeProject({ id: 'project-1', sourceRepoIds: ['r1'] })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      projects: [project],
      projectHostSetups: [
        makeProjectHostSetup({ id: 'setup-1', projectId: project.id, repoId: '' })
      ]
    })

    const store = await createStore()
    store.updateProject(project.id, {
      terminalBackendPreference: 'herdr',
      terminalBackendByHost: { local: { backend: 'herdr', state: 'ready' } }
    })
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getProjects()[0]?.terminalBackendPreference).toBe('herdr')
    expect(reloaded.getProjects()[0]?.terminalBackendByHost).toEqual({
      local: { backend: 'herdr', state: 'ready' }
    })
  })

  it('clears nullable Herdr project settings explicitly', async () => {
    const project = makeProject({
      id: 'project-1',
      sourceRepoIds: ['r1'],
      herdrSessionName: 'custom-session',
      terminalBackendPreference: 'herdr',
      terminalBackendByHost: { local: { backend: 'herdr', state: 'ready' } }
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      projects: [project],
      projectHostSetups: [
        makeProjectHostSetup({ id: 'setup-1', projectId: project.id, repoId: '' })
      ]
    })

    const store = await createStore()
    store.updateProject(project.id, {
      herdrSessionName: null,
      terminalBackendPreference: null,
      terminalBackendByHost: null
    })

    expect(store.getProjects()[0]).not.toHaveProperty('herdrSessionName')
    expect(store.getProjects()[0]).not.toHaveProperty('terminalBackendPreference')
    expect(store.getProjects()[0]).not.toHaveProperty('terminalBackendByHost')
  })

  it('falls back safely when persisted terminal backend settings are malformed', async () => {
    const state = getDefaultPersistedState(testState.dir)
    writeDataFile({
      ...state,
      settings: {
        ...state.settings,
        terminalBackendDefault: 'unknown',
        herdrBinarySource: { kind: 'custom', path: '   ' }
      }
    } as unknown as Parameters<typeof writeDataFile>[0])

    const store = await createStore()
    expect(store.getSettings().terminalBackendDefault).toBe('orca')
    expect(store.getSettings().herdrBinarySource).toEqual({ kind: 'system' })
  })

  it('defaults the shared herdr session name and normalizes edits and clears', async () => {
    const store = await createStore()
    expect(store.getSettings().herdrSessionName).toBe('orca')

    const updated = store.updateSettings({ herdrSessionName: ' shared-session ' })
    expect(updated.herdrSessionName).toBe('shared-session')

    const cleared = store.updateSettings({ herdrSessionName: '   ' })
    expect(cleared.herdrSessionName).toBeUndefined()
  })

  it('falls back to the default when a persisted shared session name is malformed', async () => {
    const state = getDefaultPersistedState(testState.dir)
    writeDataFile({
      ...state,
      settings: {
        ...state.settings,
        herdrSessionName: '   ',
        terminalBackendDefault: 'unknown'
      }
    } as unknown as Parameters<typeof writeDataFile>[0])

    const store = await createStore()
    expect(store.getSettings().herdrSessionName).toBe('orca')
  })

  it('keeps projects from older profiles activated on Orca', async () => {
    const project = makeProject({ id: 'project-1', sourceRepoIds: ['r1'] })
    const legacyState = getDefaultPersistedState(testState.dir)
    writeDataFile({
      ...legacyState,
      settings: {
        ...legacyState.settings,
        terminalBackendActivationDefaultedToOrca: undefined
      },
      projects: [project],
      projectHostSetups: [
        makeProjectHostSetup({ id: 'local-setup', projectId: project.id, hostId: 'local' }),
        makeProjectHostSetup({ id: 'ssh-setup', projectId: project.id, hostId: 'ssh:server-1' })
      ]
    })

    const store = await createStore()

    expect(store.getProjects()[0]?.terminalBackendByHost).toEqual({
      local: { backend: 'orca', state: 'ready' },
      'ssh:server-1': { backend: 'orca', state: 'ready' }
    })
  })
})
