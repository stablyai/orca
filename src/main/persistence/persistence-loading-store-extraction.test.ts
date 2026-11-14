import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedState,
  readPersistedStateJson,
  createStore,
  dataFile,
  makeRepo,
  testState
} from './persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProfileStateStore } from './profile-state/startup/profile-state-store-factory'
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

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  return { ...actual, writeSync: vi.fn(actual.writeSync) }
})

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

  it('keeps the last constructed Store as the global pane-migration listener owner', async () => {
    const first = await createStore()
    const { Store } = await import('./loading-store/store')
    const { setMigrationUnsupportedPty } =
      await import('../agent-hooks/observations/migration-unsupported-pty-state')
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

    const firstState = readPersistedState(dataFile())
    const secondState = readPersistedState(secondDataFile)
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
    const persisted = readPersistedState(dataFile())
    expect(persisted.ui.sidebarWidth).toBe(731)
    expect(store.getUI().sidebarWidth).toBe(732)
  })

  it('includes a same-tick mutation made after final flush is invoked', async () => {
    const store = await createStore()
    store.updateUI({ sidebarWidth: 741 })

    const finalFlush = store.flushAsync()
    store.updateUI({ sidebarWidth: 742 })
    await finalFlush

    const persisted = readPersistedState(dataFile())
    expect(persisted.ui.sidebarWidth).toBe(742)
  })
})
