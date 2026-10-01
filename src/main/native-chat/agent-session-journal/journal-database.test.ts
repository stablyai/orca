import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  JOURNAL_BUSY_TIMEOUT_MS,
  JOURNAL_SIZE_LIMIT_BYTES,
  journalPragmaNumber,
  NO_LEGACY_JOURNAL_RECORDS,
  openJournalDatabase
} from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import { JournalUnreleasedSchemaError } from './journal-open-failure'
import {
  deleteJournalEpochRows,
  deleteJournalRowSuffix,
  deleteUnpublishedJournalRows,
  insertJournalRow,
  iterateJournalEpochRows,
  publishJournalSessionEpoch,
  readJournalRowsAfter,
  readJournalSessionEpoch
} from './journal-row-table'
import type { JournalRow } from './journal-row-schema'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'

let root: string
let dbPath: string

function epochRow(seq: number, epoch = 'epoch-1'): JournalRow {
  return {
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch,
    seq,
    fence: 0,
    ts: 1_700_000_000_000 + seq
  }
}

const SESSION = { sessionId: 'session-1', workspaceId: 'ws-1' }

function rowsOf(db: Database.Database, sessionId: string, epoch: string): number[] {
  return [...iterateJournalEpochRows(db, sessionId, epoch)].map((row) => row.seq)
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-db-'))
  dbPath = journalDatabasePath(root)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('the host journal database open', () => {
  it('creates every table and reads back every load-bearing pragma', () => {
    const db = openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS).db
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((entry) => (entry as { name: string }).name)
      expect(tables).toEqual(
        expect.arrayContaining([
          'journal_imports',
          'journal_repairs',
          'journal_rows',
          'journal_sessions',
          'journal_set_aside'
        ])
      )
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(journalPragmaNumber(db, 'synchronous')).toBe(2)
      expect(journalPragmaNumber(db, 'checkpoint_fullfsync')).toBe(1)
      expect(journalPragmaNumber(db, 'busy_timeout')).toBe(JOURNAL_BUSY_TIMEOUT_MS)
      expect(journalPragmaNumber(db, 'foreign_keys')).toBe(1)
      // 2 is INCREMENTAL, which only takes on an empty file before WAL.
      expect(journalPragmaNumber(db, 'auto_vacuum')).toBe(2)
      expect(journalPragmaNumber(db, 'journal_size_limit')).toBe(JOURNAL_SIZE_LIMIT_BYTES)
      expect(journalPragmaNumber(db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  // T5: a newer build's database opens read-only, its rows readable, and is left byte-identical.
  it('opens a newer user_version read-only without touching the file', async () => {
    const seeded = openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS).db
    publishJournalSessionEpoch(seeded, SESSION, 'epoch-1')
    insertJournalRow(seeded, 'session-1', epochRow(1))
    seeded.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 5}`)
    seeded.close()
    const before = await digest(dbPath)

    const opened = openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS)
    try {
      expect(opened.readOnly).toBe(true)
      expect(readJournalSessionEpoch(opened.db, 'session-1')).toBe('epoch-1')
      expect([...iterateJournalEpochRows(opened.db, 'session-1', 'epoch-1')]).toHaveLength(1)
      expect(() => insertJournalRow(opened.db, 'session-1', epochRow(2))).toThrow(/readonly/i)
    } finally {
      opened.db.close()
    }

    expect(await digest(dbPath)).toBe(before)
    // A read-only reader of a WAL file may leave an empty log beside it, never a frame.
    expect((await stat(`${dbPath}-wal`).catch(() => null))?.size ?? 0).toBe(0)
  })

  it('closes the raw connection when schema setup throws', async () => {
    const failing = join(root, 'nested', 'agent-session-journal.db')
    expect(() => openJournalDatabase(failing, NO_LEGACY_JOURNAL_RECORDS)).toThrow()
    await expect(stat(`${failing}-wal`)).rejects.toThrow()
    await expect(rm(root, { recursive: true, force: true })).resolves.toBeUndefined()
    root = await mkdtemp(join(tmpdir(), 'orca-journal-db-'))
  })
})

describe('journal row statements', () => {
  it('serves replay, resume, suffix truncation and an epoch discard', () => {
    const db = openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS).db
    try {
      db.exec('BEGIN IMMEDIATE')
      for (let seq = 1; seq <= 5; seq += 1) {
        insertJournalRow(db, 'session-1', epochRow(seq))
      }
      insertJournalRow(db, 'session-2', epochRow(1))
      publishJournalSessionEpoch(db, SESSION, 'epoch-1')
      publishJournalSessionEpoch(db, { sessionId: 'session-2', workspaceId: 'ws-1' }, 'epoch-1')
      db.exec('COMMIT')

      expect(readJournalSessionEpoch(db, 'session-1')).toBe('epoch-1')
      expect(readJournalSessionEpoch(db, 'absent')).toBeNull()
      expect(rowsOf(db, 'session-1', 'epoch-1')).toEqual([1, 2, 3, 4, 5])
      expect(readJournalRowsAfter(db, 'session-1', 'epoch-1', 3).map((row) => row.seq)).toEqual([
        4, 5
      ])

      expect(deleteJournalRowSuffix(db, 'session-1', 'epoch-1', 4)).toBe(2)
      expect(rowsOf(db, 'session-1', 'epoch-1')).toEqual([1, 2, 3])

      // Another chat in the same file is untouched by this chat's discard.
      deleteJournalEpochRows(db, 'session-1', 'epoch-1')
      expect(rowsOf(db, 'session-1', 'epoch-1')).toEqual([])
      expect(rowsOf(db, 'session-2', 'epoch-1')).toEqual([1])
    } finally {
      db.close()
    }
  })

  it('deletes only the rows no pointer names', () => {
    const db = openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS).db
    try {
      insertJournalRow(db, 'session-1', epochRow(1, 'epoch-copying'))
      insertJournalRow(db, 'session-2', epochRow(1, 'epoch-live'))
      insertJournalRow(db, 'session-2', epochRow(1, 'epoch-stale'))
      publishJournalSessionEpoch(db, { sessionId: 'session-2', workspaceId: 'ws-1' }, 'epoch-live')

      deleteUnpublishedJournalRows(db, 'session-1')
      deleteUnpublishedJournalRows(db, 'session-2')

      expect(rowsOf(db, 'session-1', 'epoch-copying')).toEqual([])
      expect(rowsOf(db, 'session-2', 'epoch-live')).toEqual([1])
      expect(rowsOf(db, 'session-2', 'epoch-stale')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('refuses a duplicate sequence inside one epoch of one chat', () => {
    const db = openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS).db
    try {
      insertJournalRow(db, 'session-1', epochRow(1))
      expect(() => insertJournalRow(db, 'session-1', epochRow(1))).toThrow()
      insertJournalRow(db, 'session-1', epochRow(1, 'epoch-2'))
      insertJournalRow(db, 'session-2', epochRow(1))
    } finally {
      db.close()
    }
  })

  it('moves the epoch pointer in place', () => {
    const db = openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS).db
    try {
      publishJournalSessionEpoch(db, SESSION, 'epoch-1')
      publishJournalSessionEpoch(db, SESSION, 'epoch-2')
      expect(readJournalSessionEpoch(db, 'session-1')).toBe('epoch-2')
      expect(db.prepare('SELECT count(*) AS total FROM journal_sessions').get()).toMatchObject({
        total: 1
      })
    } finally {
      db.close()
    }
  })
})

describe('schema creation', () => {
  it('publishes no table until the version bump commits with it', () => {
    const original = Database.prototype.pragma
    const pragma = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      options?: { simple?: boolean }
    ) {
      if (sql.startsWith('user_version =')) {
        throw new Error('crash before the version is published')
      }
      return original.call(this, sql, options)
    })

    expect(() => openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS)).toThrow(
      'crash before the version is published'
    )
    pragma.mockRestore()

    const inspected = new Database(dbPath)
    try {
      expect(inspected.pragma('user_version', { simple: true })).toBe(0)
      expect(
        inspected
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_rows'")
          .get()
      ).toBeUndefined()
    } finally {
      inspected.close()
    }
  })

  // Versions 1 and 2 were written only by unreleased builds; neither is migrated.
  it.each([1, 2])('refuses a version %i database without touching the file', async (version) => {
    const earlier = new Database(dbPath)
    earlier.pragma('journal_mode = WAL')
    earlier.exec(`
CREATE TABLE journal_rows (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, row_json TEXT NOT NULL);
CREATE TABLE journal_sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL, block INTEGER NOT NULL UNIQUE, status_json TEXT, status_seq INTEGER);
INSERT INTO journal_sessions VALUES ('s1', 'ws', 'e1', 0, NULL, NULL);`)
    earlier.pragma(`user_version = ${version}`)
    earlier.pragma('journal_mode = DELETE')
    earlier.close()
    const before = await digest(dbPath)

    expect(() => openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS)).toThrow(
      `unreleased schema ${version}`
    )
    expect(() => openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS)).toThrow(
      JournalUnreleasedSchemaError
    )

    expect(await digest(dbPath)).toBe(before)
    await expect(stat(`${dbPath}-wal`)).rejects.toThrow()
  })
})
