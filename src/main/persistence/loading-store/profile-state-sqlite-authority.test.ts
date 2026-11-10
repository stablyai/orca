import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateSnapshot
} from '../profile-state/profile-state-documents'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../profile-state/profile-state-database'
import { profileStateJsonExportPath } from '../profile-state/legacy-json/profile-state-export-path'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'

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

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

const { Store } = await import('./store')

const temporaryDirectories: string[] = []
const backupAuthorities = new Set<ProfileStateSqliteAuthority>()
const authorities = new Set<ProfileStateSqliteAuthority>()
const scheduleBackup = ProfileStateSqliteAuthority.prototype.scheduleBackup

function createAuthority(databasePath: string, profileId: string): ProfileStateSqliteAuthority {
  const authority = new ProfileStateSqliteAuthority(databasePath, profileId)
  authorities.add(authority)
  return authority
}

beforeEach(() => {
  vi.spyOn(ProfileStateSqliteAuthority.prototype, 'scheduleBackup').mockImplementation(function (
    this: ProfileStateSqliteAuthority
  ) {
    backupAuthorities.add(this)
    scheduleBackup.call(this)
  })
})

afterEach(async () => {
  for (const authority of authorities) {
    authority.close()
    await authority.drainBackups()
  }
  authorities.clear()
  backupAuthorities.clear()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('Store with an injected SQLite profile-state authority', () => {
  it('rejects profile-state buffers that are not valid UTF-8', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-invalid-utf8-'))
    temporaryDirectories.push(directory)
    const authority = createAuthority(join(directory, 'profile-state.db'), 'profile-authority-test')

    authority.writeSerializedState(Buffer.from('{"settings":{"theme":"dark"}}'))
    const before = authority.readSerializedState()
    const malformed = Buffer.concat([
      Buffer.from('{"settings":{"theme":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}')
    ])
    expect(() => authority.writeSerializedState(malformed)).toThrow(
      'Profile state payload is not valid UTF-8'
    )
    expect(authority.readSerializedState()).toBe(before)
    authority.close()
  })

  it('mutates, flushes, and reloads without writing the legacy JSON file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-authority-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databaseFile = join(directory, 'profile-state.db')
    writeFileSync(dataFile, '{"settings":{"theme":"light"}}', 'utf8')
    const legacyBytes = readFileSync(dataFile)
    const authority = createAuthority(databaseFile, 'profile-authority-test')

    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.updateSettings({ theme: 'dark', opencodeSessionCookie: 'authority-secret' })
    store.flushOrThrow()

    store.updateSettings({ terminalFontSize: store.getSettings().terminalFontSize + 1 })
    await store.flushPendingOrThrowAsync()

    expect(readFileSync(dataFile).equals(legacyBytes)).toBe(true)
    expect(existsSync(databaseFile)).toBe(true)

    const reloaded = new Store({ dataFile, profileStateAuthority: authority })
    expect(reloaded.getSettings().theme).toBe('dark')
    expect(reloaded.getSettings().terminalFontSize).toBe(store.getSettings().terminalFontSize)
    expect(reloaded.getSettings().opencodeSessionCookie).toBe('authority-secret')
    expect(readFileSync(dataFile).equals(legacyBytes)).toBe(true)
    reloaded.freezeWrites()
  })

  it('rejects a corrupt ordering placeholder when normalized rows exist', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-normalized-read-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const fixture = buildProfileStateCutoverFixture()
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(JSON.stringify(fixture)))
    authority.close()

    const opened = openProfileStateDatabase(databasePath, 'profile-authority-test')
    opened.db
      .prepare('UPDATE profile_state_documents SET payload = ? WHERE domain = ?')
      .run('{invalid', 'automationRuns')
    opened.db.close()

    const runtime = createAuthority(databasePath, 'profile-authority-test')
    expect(() => runtime.readSerializedState()).toThrow(/hash mismatch: automationRuns/)
    runtime.close()

    const strict = openProfileStateDatabaseReadOnly(databasePath, 'profile-authority-test')
    try {
      expect(() => readProfileStateSnapshot(strict.db)).toThrow(/hash mismatch: automationRuns/)
    } finally {
      strict.db.close()
    }
  })

  it('rejects invalid domain JSON before handing it to the Store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-runtime-parse-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'dark' } })))
    authority.close()

    const opened = openProfileStateDatabase(databasePath, 'profile-authority-test')
    opened.db
      .prepare('UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = ?')
      .run('{invalid', hashProfileStateJson('{invalid'), 'settings')
    opened.db.close()

    expect(
      () =>
        new Store({
          dataFile: join(directory, 'orca-data.json'),
          profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
        })
    ).toThrow('Profile state document payload is invalid JSON: settings')
  })

  it('rejects documents whose revision metadata was removed or reset', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-authority-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const opened = openProfileStateDatabase(databasePath, 'profile-authority-test')
    importProfileStateJson(opened.db, JSON.stringify({ settings: { theme: 'dark' } }))
    opened.db.prepare("DELETE FROM profile_state_meta WHERE key = 'revision'").run()
    opened.db.close()

    const authority = createAuthority(databasePath, 'profile-authority-test')
    expect(() => authority.readSerializedState()).toThrow()
  })

  it('fences a complete-document writer that read before another authority committed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-authority-cas-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const first = createAuthority(databasePath, 'profile-authority-test')
    const second = createAuthority(databasePath, 'profile-authority-test')

    first.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'light' } })))
    expect(second.readSerializedState()).toBe(JSON.stringify({ settings: { theme: 'light' } }))

    first.readSerializedState()
    first.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'dark' } })))
    expect(() =>
      second.writeSerializedState(
        Buffer.from(JSON.stringify({ settings: { theme: 'stale-writer' } }))
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'profile-state-revision-conflict',
        expectedRevision: 1,
        actualRevision: 2
      })
    )

    const verifier = createAuthority(databasePath, 'profile-authority-test')
    expect(verifier.readSerializedState()).toBe(JSON.stringify({ settings: { theme: 'dark' } }))
  })

  it('fences a first commit after another authority creates the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-authority-create-cas-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const first = createAuthority(databasePath, 'profile-authority-test')
    const second = createAuthority(databasePath, 'profile-authority-test')

    expect(first.readSerializedState()).toBeUndefined()
    second.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'other' } })))

    expect(() =>
      first.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'stale' } })))
    ).toThrowError(
      expect.objectContaining({
        code: 'profile-state-revision-conflict',
        expectedRevision: 0,
        actualRevision: 1
      })
    )
  })

  it('refuses to overwrite a conflicting export for the same SQLite revision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-export-conflict-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'dark' } })))
    const store = new Store({ dataFile, profileStateAuthority: authority })
    const revision = store.writeLatestProfileStateJsonExport()
    if (revision === undefined) {
      throw new Error('Expected the SQLite authority to publish a revisioned export')
    }
    const exportPath = profileStateJsonExportPath(dataFile, revision)
    mkdirSync(dirname(exportPath), { recursive: true })
    writeFileSync(exportPath, '{"settings":{"theme":"tampered"}}', 'utf8')

    expect(() => store.writeLatestProfileStateJsonExport()).toThrow(
      'already exists with different content'
    )
    expect(readFileSync(exportPath, 'utf8')).toContain('tampered')
    expect(
      readdirSync(directory).some((name) =>
        name.startsWith('orca-data.json.sqlite-export.pending.')
      )
    ).toBe(false)
    store.freezeWrites()
  })

  it('freezes Store writes before quarantining the SQLite database family', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-quarantine-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'light' } })))

    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.updateSettings({ theme: 'dark' })
    store.flushOrThrow()
    await authority.drainBackups()
    const sourceBytes = readFileSync(databasePath)
    writeFileSync(`${databasePath}-wal`, 'wal-preservation-sentinel')

    const result = store.quarantineProfileStateDatabase(
      join(directory, 'quarantine'),
      'store-recovery-test'
    )

    expect(readFileSync(join(result.directory, 'profile-state.db')).equals(sourceBytes)).toBe(true)
    expect(readFileSync(join(result.directory, 'profile-state.db-wal'), 'utf8')).toBe(
      'wal-preservation-sentinel'
    )
    expect(JSON.parse(readFileSync(result.manifestPath, 'utf8'))).toMatchObject({
      profileId: 'profile-authority-test',
      reason: 'store-recovery-test'
    })
    expect(readFileSync(databasePath).equals(sourceBytes)).toBe(true)
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
  })

  it('prepares frozen JSON imports without permitting file publication', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-legacy-export-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const store = new Store({ dataFile, serializedState: '{"settings":{"theme":"light"}}' })
    store.updateSettings({ theme: 'dark' })

    const exportPath = join(directory, 'rollback', 'orca-data.json.legacy.json')
    expect(() => store.writeProfileStateJsonExport(exportPath)).toThrow('require a SQLite')
    expect(JSON.parse(store.prepareProfileStateExport().json).settings.theme).toBe('dark')
    expect(existsSync(exportPath)).toBe(false)
    expect(existsSync(dataFile)).toBe(false)
    expect(existsSync(join(directory, 'profile-state.db'))).toBe(false)
    store.freezeWrites()
  })
})
