import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly,
  profileStateDatabaseFile,
  profileStatePragmaNumber,
  PROFILE_STATE_BUSY_TIMEOUT_MS,
  PROFILE_STATE_DATABASE_FILE_NAME
} from './profile-state-database'
import { PROFILE_STATE_DATABASE_SCHEMA_VERSION } from './profile-state-database-schema'
import { importProfileStateJson } from './profile-state-documents'
import { quarantineProfileStateDatabase } from './profile-state-database-quarantine'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-db-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('profile state database', () => {
  it('creates an isolated per-profile schema with durable pragmas', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const opened = openProfileStateDatabase(dbPath, 'profile-a')
    try {
      expect(dbPath).toBe(join(directory, PROFILE_STATE_DATABASE_FILE_NAME))
      expect(opened.readOnly).toBe(false)
      expect(opened.profileId).toBe('profile-a')
      expect(profileStatePragmaNumber(opened.db, 'user_version')).toBe(
        PROFILE_STATE_DATABASE_SCHEMA_VERSION
      )
      expect(opened.db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(profileStatePragmaNumber(opened.db, 'synchronous')).toBe(2)
      expect(profileStatePragmaNumber(opened.db, 'busy_timeout')).toBe(
        PROFILE_STATE_BUSY_TIMEOUT_MS
      )
      expect(profileStatePragmaNumber(opened.db, 'foreign_keys')).toBe(1)
      expect(
        opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      ).toEqual([
        { name: 'profile_state_automation_runs' },
        { name: 'profile_state_automation_runs_meta' },
        { name: 'profile_state_documents' },
        { name: 'profile_state_meta' }
      ])
      expect(
        opened.db.prepare('SELECT value FROM profile_state_meta WHERE key = ?').get('profile_id')
      ).toEqual({ value: 'profile-a' })
    } finally {
      opened.db.close()
    }
  })

  it('migrates the version-1 document schema by adding normalized run tables', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const seeded = new Database(dbPath)
    seeded.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE profile_state_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE profile_state_documents (
        domain TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        domain_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        content_hash TEXT NOT NULL
      );
      INSERT INTO profile_state_meta (key, value) VALUES ('profile_id', 'profile-a');
      INSERT INTO profile_state_meta (key, value) VALUES ('revision', '1');
      INSERT INTO profile_state_documents
        (domain, payload, domain_version, revision, updated_at, content_hash)
      VALUES ('settings', '{"theme":"dark"}', 1, 1, 100, '0f4f87db4567232a7f1756aa1534ec1314777b39c3bf5209f87cf9739321cddc');
    `)
    seeded.close()

    const opened = openProfileStateDatabase(dbPath, 'profile-a')
    try {
      expect(profileStatePragmaNumber(opened.db, 'user_version')).toBe(
        PROFILE_STATE_DATABASE_SCHEMA_VERSION
      )
      expect(
        opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      ).toEqual([
        { name: 'profile_state_automation_runs' },
        { name: 'profile_state_automation_runs_meta' },
        { name: 'profile_state_documents' },
        { name: 'profile_state_meta' }
      ])
      expect(
        opened.db
          .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
          .get('settings')
      ).toEqual({ payload: '{"theme":"dark"}' })
    } finally {
      opened.db.close()
    }
  })

  it('validates normalized tables created during migration', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const seeded = new Database(dbPath)
    seeded.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE profile_state_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE profile_state_documents (
        domain TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        domain_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE TABLE profile_state_automation_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        ordinal INTEGER NOT NULL,
        payload BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO profile_state_meta (key, value) VALUES ('profile_id', 'profile-a');
    `)
    seeded.close()

    expect(() => openProfileStateDatabase(dbPath, 'profile-a')).toThrowError(
      expect.objectContaining({ code: 'unreadable' })
    )
  })

  it('latches a future schema read-only without changing the database file', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const seeded = openProfileStateDatabase(dbPath, 'profile-a')
    seeded.db.pragma(`user_version = ${PROFILE_STATE_DATABASE_SCHEMA_VERSION + 9}`)
    seeded.db.close()
    const before = statSync(dbPath)
    const beforeBytes = readFileSync(dbPath)

    const opened = openProfileStateDatabase(dbPath, 'profile-a')
    try {
      expect(opened.readOnly).toBe(true)
      expect(profileStatePragmaNumber(opened.db, 'user_version')).toBe(
        PROFILE_STATE_DATABASE_SCHEMA_VERSION + 9
      )
      expect(() => opened.db.exec("INSERT INTO profile_state_meta VALUES ('x', 'y')")).toThrow()
    } finally {
      opened.db.close()
    }
    const after = statSync(dbPath)
    expect(after.size).toBe(before.size)
    expect(readFileSync(dbPath)).toEqual(beforeBytes)
  })

  it('opens the current schema read-only without changing its bytes', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const seeded = openProfileStateDatabase(dbPath, 'profile-a')
    seeded.db.close()
    const before = readFileSync(dbPath)

    const opened = openProfileStateDatabaseReadOnly(dbPath, 'profile-a')
    try {
      expect(opened.readOnly).toBe(true)
      expect(() => opened.db.exec("INSERT INTO profile_state_meta VALUES ('x', 'y')")).toThrow()
    } finally {
      opened.db.close()
    }
    expect(readFileSync(dbPath)).toEqual(before)
  })

  it('rejects a database whose profile identity does not match', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const opened = openProfileStateDatabase(dbPath, 'profile-a')
    opened.db.close()
    const before = readFileSync(dbPath)

    expect(() => openProfileStateDatabase(dbPath, 'profile-b')).toThrowError(
      expect.objectContaining({ code: 'identity-mismatch' })
    )
    expect(readFileSync(dbPath)).toEqual(before)
  })

  it('rejects malformed database bytes without replacing them', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const bytes = Buffer.from('not a sqlite database')
    writeFileSync(dbPath, bytes)

    expect(() => openProfileStateDatabase(dbPath, 'profile-a')).toThrowError(
      expect.objectContaining({ code: 'unreadable' })
    )
    expect(readFileSync(dbPath)).toEqual(bytes)
  })

  it('quarantines the database family without touching live recovery sources', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const opened = openProfileStateDatabase(dbPath, 'profile-a')
    importProfileStateJson(opened.db, JSON.stringify({ settings: { theme: 'dark' } }))
    opened.db.close()
    writeFileSync(`${dbPath}-wal`, 'wal-preservation-sentinel')

    const sourceBytes = new Map(
      [dbPath, `${dbPath}-wal`].map((path) => [path, readFileSync(path).toString('hex')])
    )
    const result = quarantineProfileStateDatabase(
      dbPath,
      'profile-a',
      join(directory, 'quarantine'),
      'test-corruption'
    )

    expect(result.copiedFiles).toHaveLength(2)
    expect(JSON.parse(readFileSync(result.manifestPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      profileId: 'profile-a',
      reason: 'test-corruption',
      sourceFiles: expect.arrayContaining(['', '-wal'])
    })
    expect(readFileSync(join(result.directory, 'profile-state.db')).toString('hex')).toBe(
      sourceBytes.get(dbPath)
    )
    expect(readFileSync(join(result.directory, 'profile-state.db-wal')).toString('hex')).toBe(
      sourceBytes.get(`${dbPath}-wal`)
    )
    for (const [path, bytes] of sourceBytes) {
      expect(readFileSync(path).toString('hex')).toBe(bytes)
    }
  })

  it('rejects an unexpected version-0 schema without mutating it', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const seeded = new Database(dbPath)
    seeded.exec('CREATE TABLE unrelated (value TEXT)')
    seeded.close()
    const before = readFileSync(dbPath)

    expect(() => openProfileStateDatabase(dbPath, 'profile-a')).toThrowError(
      expect.objectContaining({ code: 'unreadable' })
    )
    expect(readFileSync(dbPath)).toEqual(before)
  })

  it('rejects an incomplete current schema without mutating it', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const seeded = openProfileStateDatabase(dbPath, 'profile-a')
    seeded.db.exec('DROP TABLE profile_state_documents')
    seeded.db.close()
    const before = readFileSync(dbPath)

    expect(() => openProfileStateDatabase(dbPath, 'profile-a')).toThrowError(
      expect.objectContaining({ code: 'unreadable' })
    )
    expect(readFileSync(dbPath)).toEqual(before)
  })

  it('rejects current-version tables with incompatible columns without mutating them', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const seeded = new Database(dbPath)
    seeded.exec(`
      PRAGMA user_version = ${PROFILE_STATE_DATABASE_SCHEMA_VERSION};
      CREATE TABLE profile_state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profile_state_documents (
        domain TEXT PRIMARY KEY,
        payload BLOB NOT NULL,
        revision INTEGER NOT NULL
      );
    `)
    seeded.close()
    const before = readFileSync(dbPath)

    expect(() => openProfileStateDatabase(dbPath, 'profile-a')).toThrowError(
      expect.objectContaining({ code: 'unreadable' })
    )
    expect(readFileSync(dbPath)).toEqual(before)
  })

  it('does not create an empty database when the parent directory is absent', () => {
    const directory = createDirectory()
    const dbPath = join(directory, 'missing', PROFILE_STATE_DATABASE_FILE_NAME)

    expect(() => openProfileStateDatabase(dbPath, 'profile-a')).toThrowError(
      expect.objectContaining({ code: 'unreadable' })
    )
  })

  it('rejects an empty profile identity before opening SQLite', () => {
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)

    expect(() => openProfileStateDatabase(dbPath, '')).toThrowError(
      expect.objectContaining({ code: 'invalid-profile-id' })
    )
  })

  it('restricts the database and WAL sidecars on POSIX', () => {
    if (process.platform === 'win32') {
      return
    }
    const directory = createDirectory()
    const dbPath = profileStateDatabaseFile(directory)
    const opened = openProfileStateDatabase(dbPath, 'profile-a')
    opened.db
      .prepare('INSERT INTO profile_state_documents VALUES (?, ?, ?, ?, ?, ?)')
      .run('settings', '{}', 1, 1, Date.now(), 'hash')
    try {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }
    } finally {
      opened.db.close()
    }
  })
})

describe('profile state database does not reuse orchestration state', () => {
  it('uses a profile-local filename', () => {
    const directory = createDirectory()
    expect(profileStateDatabaseFile(directory)).not.toBe(join(directory, 'orchestration.db'))
  })
})
