import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson,
  writePersistedStateJson,
  createStore,
  dataFile,
  makeRepo,
  testState
} from './persistence-test-harness'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createProfileStateStore } from './persistence/profile-state/profile-state-store-factory'
import type * as FsModule from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../shared/constants'
import type { PersistedState } from '../shared/persisted-state-types'
import type { Store as PersistenceStore } from './persistence/loading-store/store'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(() => ({ nth_repo_added: 2 }))
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
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  return { ...actual, writeSync: vi.fn(actual.writeSync) }
})

function getLoadDoneLines(): string[] {
  return vi
    .mocked(writeSync)
    .mock.calls.flatMap(([fd, text]) =>
      fd === 2 && typeof text === 'string' && text.startsWith('[startup] persistence-load-done ')
        ? [text]
        : []
    )
}

describe('loading Store extraction seams', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-loading-store-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.mocked(writeSync).mockClear()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('does not serialize the workspace session when startup diagnostics are disabled', () => {
    const sentinel = 'startup-diagnostics-workspace-session-sentinel-disabled'
    vi.stubEnv('ORCA_STARTUP_DIAGNOSTICS', '')
    const state = getDefaultPersistedState(testState.dir)
    state.workspaceSession = { ...state.workspaceSession, activeTabId: sentinel }
    writePersistedStateJson(dataFile(), JSON.stringify(state))

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
    expect(getLoadDoneLines()).toEqual([])
  })

  it('reports the unchanged workspace-session byte count when startup diagnostics are enabled', () => {
    const sentinel = 'startup-diagnostics-workspace-session-sentinel-enabled'
    vi.stubEnv('ORCA_STARTUP_DIAGNOSTICS', '1')
    const state = getDefaultPersistedState(testState.dir)
    state.workspaceSession = { ...state.workspaceSession, activeTabId: sentinel }
    writePersistedStateJson(dataFile(), JSON.stringify(state))

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
    const expectedBytes = Buffer.byteLength(JSON.stringify(store.getWorkspaceSession()))
    expect(getLoadDoneLines()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^\\[startup\\] persistence-load-done t=\\d+ repos=${state.repos.length} workspaceSessionBytes=${expectedBytes}\\n$`
        )
      )
    ])
  })

  it('timestamps persistence-load-done before resolving its details closure', () => {
    const sentinel = 'startup-diagnostics-workspace-session-sentinel-ordering'
    vi.stubEnv('ORCA_STARTUP_DIAGNOSTICS', '1')
    const state = getDefaultPersistedState(testState.dir)
    state.workspaceSession = { ...state.workspaceSession, activeTabId: sentinel }
    writePersistedStateJson(dataFile(), JSON.stringify(state))

    // Fake clock only the details closure advances, so a post-closure timestamp is unambiguous.
    let clock = 0
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const realStringify = JSON.stringify
    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation(((
      value: unknown,
      ...rest: unknown[]
    ) => {
      if (
        value &&
        typeof value === 'object' &&
        (value as { activeTabId?: unknown }).activeTabId === sentinel
      ) {
        clock += 1000
      }
      return (realStringify as (...args: unknown[]) => string)(value, ...rest)
    }) as typeof JSON.stringify)

    try {
      const store = createStore()
      store.freezeWrites()
    } finally {
      stringifySpy.mockRestore()
      nowSpy.mockRestore()
    }

    expect(getLoadDoneLines()).toEqual([
      expect.stringMatching(
        /^\[startup\] persistence-load-done t=0 repos=\d+ workspaceSessionBytes=\d+\n$/
      )
    ])
  })

  it('imports the first usable legacy backup without overwriting the damaged source', () => {
    writeFileSync(dataFile(), '{{corrupt-primary', 'utf-8')
    writeFileSync(`${dataFile()}.bak.0`, '{}', 'utf-8')
    writeFileSync(
      `${dataFile()}.bak.1`,
      JSON.stringify({ repos: [makeRepo({ id: 'older-complete-profile' })] }),
      'utf-8'
    )
    const { store } = createProfileStateStore({
      dataFile: dataFile(),
      databaseFile: join(testState.dir, 'profile-state.db'),
      profileId: 'backup-import'
    })
    try {
      expect(store.getRepos()).toEqual([])
      expect(readFileSync(dataFile(), 'utf-8')).toBe('{{corrupt-primary')
      expect(readPersistedStateJson(dataFile(), 'backup-import')).toContain('"repos":[]')
    } finally {
      store.freezeWrites()
    }
  })

  it('leaves backup bytes reusable when the legacy source cannot be read', () => {
    mkdirSync(dataFile(), { recursive: true })
    const backup = JSON.stringify({ repos: [makeRepo({ id: 'recovery-survives-read-failure' })] })
    writeFileSync(`${dataFile()}.bak.0`, backup, 'utf-8')
    expect(() =>
      createProfileStateStore({
        dataFile: dataFile(),
        databaseFile: join(testState.dir, 'profile-state.db'),
        profileId: 'backup-import'
      })
    ).toThrow()
    expect(readFileSync(`${dataFile()}.bak.0`, 'utf-8')).toBe(backup)
    expect(existsSync(join(testState.dir, 'profile-state.db'))).toBe(false)
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

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as PersistedState
    expect(persisted.workspaceSession?.activeRepoId).toBe('from-blank-patch')
    expect(persisted.workspaceSessionsByHostId).toEqual({})
  })

  it('keeps the last constructed Store as the global pane-migration listener owner', async () => {
    const first = await createStore()
    const { Store } = await import('./persistence/loading-store/store')
    const { setMigrationUnsupportedPty } =
      await import('./agent-hooks/migration-unsupported-pty-state')
    const secondDataFile = join(testState.dir, 'second-profile', 'orca-data.json')
    const second = createSqliteTestStore(Store, { dataFile: secondDataFile })

    setMigrationUnsupportedPty({
      ptyId: 'listener-owner-pty',
      reason: 'legacy-numeric-pane-key',
      source: 'local',
      updatedAt: 123
    })
    first.flushOrThrow()
    second.flushOrThrow()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const firstState = JSON.parse(readPersistedStateJson(dataFile())) as PersistedState
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const secondState = JSON.parse(readPersistedStateJson(secondDataFile)) as PersistedState
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as PersistedState
    expect(persisted.ui.sidebarWidth).toBe(731)
    expect(store.getUI().sidebarWidth).toBe(732)
  })

  it('includes a same-tick mutation made after final flush is invoked', async () => {
    const store = await createStore()
    store.updateUI({ sidebarWidth: 741 })

    const finalFlush = store.flushAsync()
    store.updateUI({ sidebarWidth: 742 })
    await finalFlush

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as PersistedState
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
    const overridden = createSqliteTestStore(StoreWithRepoCountOverride, {
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
