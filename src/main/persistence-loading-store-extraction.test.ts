import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../shared/constants'
import type { PersistedState } from '../shared/persisted-state-types'
import type * as StartupDiagnosticsModule from './startup/startup-diagnostics'
import type { Store as PersistenceStore } from './persistence/loading-store/store'
import {
  createStore,
  dataFile,
  makeRepo,
  testState,
  writeDataFile
} from './persistence-test-harness'

const { trackMock, getCohortAtEmitMock, logStartupDiagnosticMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(() => ({ nth_repo_added: 2 })),
  logStartupDiagnosticMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
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

vi.mock('./telemetry/client', () => ({ track: trackMock }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))
vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))
vi.mock('./startup/startup-diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof StartupDiagnosticsModule>()
  return { ...actual, logStartupDiagnostic: logStartupDiagnosticMock }
})

describe('loading Store extraction seams', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-loading-store-'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    logStartupDiagnosticMock.mockReset()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('does not serialize the workspace session when startup diagnostics are disabled', () => {
    const sentinel = 'startup-diagnostics-workspace-session-sentinel-disabled'
    vi.stubEnv('ORCA_STARTUP_DIAGNOSTICS', '')
    const state = getDefaultPersistedState(testState.dir)
    state.workspaceSession = { ...state.workspaceSession, activeTabId: sentinel }
    writeDataFile(state)

    const stringifySpy = vi.spyOn(JSON, 'stringify')
    const store = createStore()
    store.freezeWrites()

    const workspaceSessionStringifyCalls = stringifySpy.mock.calls.filter(
      ([value]) =>
        value &&
        typeof value === 'object' &&
        (value as { activeTabId?: unknown }).activeTabId === sentinel
    )
    stringifySpy.mockRestore()

    expect(store.getWorkspaceSession().activeTabId).toBe(sentinel)
    expect(workspaceSessionStringifyCalls).toHaveLength(0)
    expect(
      logStartupDiagnosticMock.mock.calls.some(([event]) => event === 'persistence-load-done')
    ).toBe(false)
  })

  it('reports the unchanged workspace-session byte count when startup diagnostics are enabled', () => {
    const sentinel = 'startup-diagnostics-workspace-session-sentinel-enabled'
    vi.stubEnv('ORCA_STARTUP_DIAGNOSTICS', '1')
    const state = getDefaultPersistedState(testState.dir)
    state.workspaceSession = { ...state.workspaceSession, activeTabId: sentinel }
    writeDataFile(state)

    const stringifySpy = vi.spyOn(JSON, 'stringify')
    const store = createStore()
    store.freezeWrites()

    const workspaceSessionStringifyCalls = stringifySpy.mock.calls.filter(
      ([value]) =>
        value &&
        typeof value === 'object' &&
        (value as { activeTabId?: unknown }).activeTabId === sentinel
    )
    stringifySpy.mockRestore()

    expect(store.getWorkspaceSession().activeTabId).toBe(sentinel)
    expect(workspaceSessionStringifyCalls).toHaveLength(1)
    const loadDoneCall = logStartupDiagnosticMock.mock.calls.find(
      ([event]) => event === 'persistence-load-done'
    )
    expect(loadDoneCall).toBeDefined()
    const details = loadDoneCall?.[1] as Record<string, unknown> | undefined
    expect(details).toEqual({
      t: expect.any(Number),
      repos: state.repos.length,
      workspaceSessionBytes: Buffer.byteLength(JSON.stringify(store.getWorkspaceSession()))
    })
  })

  it('accepts the first JSON-parseable backup even when an older backup has richer state', async () => {
    mkdirSync(testState.dir, { recursive: true })
    writeFileSync(dataFile(), '{{corrupt-primary', 'utf-8')
    writeFileSync(`${dataFile()}.bak.0`, '{}', 'utf-8')
    writeFileSync(
      `${dataFile()}.bak.1`,
      JSON.stringify({ repos: [makeRepo({ id: 'older-complete-profile' })] }),
      'utf-8'
    )

    const store = await createStore()

    expect(store.getRepos()).toEqual([])
    expect(readFileSync(dataFile(), 'utf-8')).toBe('{}')
  })

  it('leaves backup bytes reusable when publishing recovery to the primary path fails', async () => {
    mkdirSync(dataFile(), { recursive: true })
    writeFileSync(
      `${dataFile()}.bak.0`,
      JSON.stringify({ repos: [makeRepo({ id: 'recovery-survives-publish-failure' })] }),
      'utf-8'
    )

    const failedRecovery = await createStore()
    expect(failedRecovery.getRepos()).toEqual([])
    failedRecovery.freezeWrites()
    expect(existsSync(`${dataFile()}.bak.0`)).toBe(true)

    rmSync(dataFile(), { recursive: true, force: true })
    const recovered = await createStore()
    expect(recovered.getRepos().map((repo) => repo.id)).toEqual([
      'recovery-survives-publish-failure'
    ])
  })

  it('aliases blank host reads, writes, and patches to the local disk partition', async () => {
    const store = await createStore()
    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), activeRepoId: 'from-blank-set' },
      '   '
    )
    store.patchWorkspaceSession({ activeRepoId: 'from-blank-patch' }, '')
    store.flushOrThrow()

    expect(store.getWorkspaceSession('  ').activeRepoId).toBe('from-blank-patch')
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local'])

    const persisted = JSON.parse(readFileSync(dataFile(), 'utf-8')) as PersistedState
    expect(persisted.workspaceSession?.activeRepoId).toBe('from-blank-patch')
    expect(persisted.workspaceSessionsByHostId).toEqual({})
  })

  it('keeps the last constructed Store as the global pane-migration listener owner', async () => {
    const first = await createStore()
    const { Store } = await import('./persistence/loading-store/store')
    const { setMigrationUnsupportedPty } =
      await import('./agent-hooks/migration-unsupported-pty-state')
    const secondDataFile = join(testState.dir, 'second-profile', 'orca-data.json')
    const second = new Store({ dataFile: secondDataFile })

    setMigrationUnsupportedPty({
      ptyId: 'listener-owner-pty',
      reason: 'legacy-numeric-pane-key',
      source: 'local',
      updatedAt: 123
    })
    first.flushOrThrow()
    second.flushOrThrow()

    const firstState = JSON.parse(readFileSync(dataFile(), 'utf-8')) as PersistedState
    const secondState = JSON.parse(readFileSync(secondDataFile, 'utf-8')) as PersistedState
    expect(
      firstState.migrationUnsupportedPtyEntries?.some(
        (entry) => entry.ptyId === 'listener-owner-pty'
      )
    ).toBe(false)
    expect(
      secondState.migrationUnsupportedPtyEntries?.some(
        (entry) => entry.ptyId === 'listener-owner-pty'
      )
    ).toBe(true)
  })

  it('latches final flush bytes and ignores later in-memory mutations', async () => {
    const store = await createStore()
    store.updateUI({ sidebarWidth: 731 })
    const finalFlush = store.flushAsync()
    await finalFlush

    store.updateUI({ sidebarWidth: 732 })
    expect(store.flushAsync()).toBe(finalFlush)
    const persisted = JSON.parse(readFileSync(dataFile(), 'utf-8')) as PersistedState
    expect(persisted.ui.sidebarWidth).toBe(731)
    expect(store.getUI().sidebarWidth).toBe(732)
  })

  it('includes a same-tick mutation made after final flush is invoked', async () => {
    const store = await createStore()
    store.updateUI({ sidebarWidth: 741 })

    const finalFlush = store.flushAsync()
    store.updateUI({ sidebarWidth: 742 })
    await finalFlush

    const persisted = JSON.parse(readFileSync(dataFile(), 'utf-8')) as PersistedState
    expect(persisted.ui.sidebarWidth).toBe(742)
  })

  it('keeps delegated operations on the Store prototype with native receiver and override semantics', async () => {
    const store = await createStore()
    const { Store } = await import('./persistence/loading-store/store')
    const descriptor = Object.getOwnPropertyDescriptor(Store.prototype, 'getRepoCount')

    expect(descriptor).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: true
    })
    expect(Object.hasOwn(store, 'getRepoCount')).toBe(false)
    const detached = store.getRepoCount
    expect(() => detached()).toThrow(TypeError)
    expect(detached.call(store)).toBe(0)
    expect(new Proxy(store, {}).getRepoCount()).toBe(0)
    expect([
      Store.prototype.getRepo.length,
      Store.prototype.updateProject.length,
      Store.prototype.createAutomationRun.length
    ]).toEqual([1, 2, 2])

    const prototypeSpy = vi.spyOn(Store.prototype, 'getRepoCount')
    try {
      expect(store.getRepoCount()).toBe(0)
      expect(prototypeSpy).toHaveBeenCalledOnce()
    } finally {
      prototypeSpy.mockRestore()
    }

    class StoreWithRepoCountOverride extends Store {
      override getRepoCount(): number {
        return 47
      }
    }
    const overridden = new StoreWithRepoCountOverride({
      dataFile: join(testState.dir, 'override-profile', 'orca-data.json')
    })
    expect(overridden.getRepoCount()).toBe(47)
    expectTypeOf<PersistenceStore>().not.toHaveProperty('scheduleSave')
    expectTypeOf<PersistenceStore>().not.toHaveProperty('enqueueWrite')
    expectTypeOf<PersistenceStore>().not.toHaveProperty('getProjectHostOperations')
    expectTypeOf<PersistenceStore>().not.toHaveProperty('getAutomationDefinitionOperations')
    expectTypeOf<PersistenceStore>().not.toHaveProperty('getSshTargetStateOperations')
  })
})
