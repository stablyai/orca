// Version 4: the chat records join the journal database, copied in by the migration's own
// transaction, so "copied" is exactly `user_version >= 4`.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  journalPragmaNumber,
  NO_LEGACY_JOURNAL_RECORDS,
  openJournalDatabase,
  readJournalDatabaseVersion,
  type JournalLegacyRecordImport
} from './journal-database'
import { createJournalTablesSql } from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'

let root: string
let dbPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-records-migration-'))
  dbPath = journalDatabasePath(root)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

/** What a build from before the records moved left: the released version-3 shape. */
function seedVersion3(): void {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(createJournalTablesSql())
  db.prepare(
    "INSERT INTO journal_sessions (session_id, workspace_id, epoch) VALUES ('s1', 'ws', 'e1')"
  ).run()
  db.pragma('user_version = 3')
  db.close()
}

/** A copy of one record row, counting how many times the migration ran it. */
function importOf(sessionId: string): JournalLegacyRecordImport & { runs: number } {
  const copy = {
    owed: false as const,
    runs: 0,
    write: (db: Database.Database) => {
      copy.runs += 1
      db.prepare(
        'INSERT OR IGNORE INTO agent_session_records (session_id, record_json) VALUES (?, ?)'
      ).run(sessionId, '{}')
    }
  }
  return copy
}

function inspect<T>(read: (db: Database.Database) => T): T {
  const db = new Database(dbPath)
  try {
    return read(db)
  } finally {
    db.close()
  }
}

const recordIds = (db: Database.Database): string[] =>
  db
    .prepare('SELECT session_id FROM agent_session_records ORDER BY session_id')
    .all()
    .map((row) => String(row.session_id))

const hasTable = (db: Database.Database, name: string): boolean =>
  db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined

describe('the version-4 migration', () => {
  it('moves a version-3 database to 4 with its rows and the copied records', () => {
    seedVersion3()
    const copy = importOf('session-a')

    const opened = openJournalDatabase(dbPath, copy)
    opened.db.close()

    expect(opened).toMatchObject({ readOnly: false, legacyRecordImportOwed: false })
    expect(copy.runs).toBe(1)
    inspect((db) => {
      expect(journalPragmaNumber(db, 'user_version')).toBe(4)
      expect(recordIds(db)).toEqual(['session-a'])
      expect(db.prepare('SELECT epoch FROM journal_sessions').get()).toEqual({ epoch: 'e1' })
    })
  })

  it('never runs the copy again once the database is at 4', () => {
    seedVersion3()
    openJournalDatabase(dbPath, importOf('session-a')).db.close()
    const again = importOf('session-b')

    openJournalDatabase(dbPath, again).db.close()

    expect(again.runs).toBe(0)
    inspect((db) => expect(recordIds(db)).toEqual(['session-a']))
  })

  it('leaves version 3 and no record rows when it dies inside the migration, then copies once', () => {
    seedVersion3()
    const original = Database.prototype.pragma
    const pragma = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      options?: { simple?: boolean }
    ) {
      if (sql === 'user_version = 4') {
        throw new Error('crash before the version is published')
      }
      return original.call(this, sql, options)
    })

    expect(() => openJournalDatabase(dbPath, importOf('session-a'))).toThrow(
      'crash before the version is published'
    )
    pragma.mockRestore()
    inspect((db) => {
      expect(journalPragmaNumber(db, 'user_version')).toBe(3)
      expect(hasTable(db, 'agent_session_records')).toBe(false)
    })

    const retry = importOf('session-a')
    openJournalDatabase(dbPath, retry).db.close()
    expect(retry.runs).toBe(1)
    inspect((db) => {
      expect(journalPragmaNumber(db, 'user_version')).toBe(4)
      expect(recordIds(db)).toEqual(['session-a'])
    })
  })

  it('makes the tables but keeps the copy owed when the records file could not be read', () => {
    seedVersion3()

    const opened = openJournalDatabase(dbPath, { owed: true })
    // A chat created while the copy is owed keeps its row through the copy that follows.
    opened.db
      .prepare("INSERT INTO agent_session_records (session_id, record_json) VALUES ('new', '{}')")
      .run()
    opened.db.close()

    expect(opened.legacyRecordImportOwed).toBe(true)
    inspect((db) => expect(journalPragmaNumber(db, 'user_version')).toBe(3))
    openJournalDatabase(dbPath, importOf('session-a')).db.close()
    inspect((db) => {
      expect(journalPragmaNumber(db, 'user_version')).toBe(4)
      expect(recordIds(db)).toEqual(['new', 'session-a'])
    })
  })

  it('stamps a fresh file with the released version while the copy is owed', () => {
    openJournalDatabase(dbPath, { owed: true }).db.close()

    inspect((db) => {
      expect(journalPragmaNumber(db, 'user_version')).toBe(3)
      expect(hasTable(db, 'journal_rows')).toBe(true)
      expect(hasTable(db, 'agent_session_records')).toBe(true)
    })
  })

  // An install's first probe must not leave an empty database that reads as a profile with chats.
  it('reads a missing database as version 0 without creating it', () => {
    expect(readJournalDatabaseVersion(dbPath)).toBe(0)
    expect(existsSync(dbPath)).toBe(false)
  })

  it('creates every table on a fresh file at version 4', () => {
    openJournalDatabase(dbPath, NO_LEGACY_JOURNAL_RECORDS).db.close()

    inspect((db) => {
      expect(journalPragmaNumber(db, 'user_version')).toBe(4)
      for (const table of [
        'journal_rows',
        'agent_session_records',
        'agent_session_operations',
        'agent_session_retired_claim_keys',
        'agent_session_tabs',
        'agent_session_store_meta'
      ]) {
        expect(hasTable(db, table)).toBe(true)
      }
    })
  })
})

/**
 * The open of a build released before the records moved (version 3), pinned here: it latches any
 * higher version read-only. Its records file stays its own and writable, so nothing it does can
 * reach the records this database holds.
 */
function openAsVersion3Build(path: string): { db: Database.Database; readOnly: boolean } {
  const probe = new Database(path)
  const stored = journalPragmaNumber(probe, 'user_version')
  if (stored > 3) {
    probe.close()
    return { db: new Database(path, { readonly: true, fileMustExist: true }), readOnly: true }
  }
  return { db: probe, readOnly: false }
}

describe('a build from before the move', () => {
  it('opens a version-4 database read-only, so it never writes beside the records', () => {
    openJournalDatabase(dbPath, importOf('session-a')).db.close()

    const older = openAsVersion3Build(dbPath)
    try {
      expect(older.readOnly).toBe(true)
      expect(() =>
        older.db
          .prepare(
            "INSERT INTO journal_sessions (session_id, workspace_id, epoch) VALUES ('s2', 'ws', 'e')"
          )
          .run()
      ).toThrow(/readonly/i)
    } finally {
      older.db.close()
    }
  })
})
