import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from './sync-database'
import { classifySqliteReadFailure, isTransientSqliteContention } from './sqlite-read-failure'

// Error codes here are the ones a real node:sqlite open produces: a contended
// database reports errcode 5 ("database is locked"), while a read-only WAL open
// with no usable -shm reports errcode 14 ("unable to open database file"). The
// two need opposite responses, so the classifier must never conflate them.

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function contendedDatabase(): { path: string; release: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-sqlite-failure-'))
  tempDirs.push(dir)
  const path = join(dir, 'contended.db')
  const writer = new SyncDatabase(path)
  writer.exec('PRAGMA journal_mode=DELETE')
  writer.exec('CREATE TABLE session (id TEXT PRIMARY KEY)')
  writer.exec('BEGIN EXCLUSIVE')
  writer.exec("INSERT INTO session VALUES ('a')")
  return {
    path,
    release: () => {
      writer.exec('COMMIT')
      writer.close()
    }
  }
}

describe('isTransientSqliteContention', () => {
  it('recognizes a real SQLITE_BUSY thrown by a read-only open', () => {
    const contended = contendedDatabase()
    let thrown: unknown
    try {
      new SyncDatabase(contended.path, { readonly: true, timeout: 0 })
        .prepare('SELECT id FROM session')
        .all()
    } catch (error) {
      thrown = error
    } finally {
      contended.release()
    }

    expect((thrown as { errcode?: number }).errcode).toBe(5)
    expect(isTransientSqliteContention(thrown)).toBe(true)
  })

  it('recognizes a relayed message with no errcode, as the Codex heal pass sees it', () => {
    expect(
      isTransientSqliteContention('codex app-server thread/read failed: database is locked')
    ).toBe(true)
    expect(isTransientSqliteContention(new Error('SQLITE_LOCKED: table is locked'))).toBe(true)
  })

  it('reads extended result codes through their primary code', () => {
    // SQLITE_BUSY_SNAPSHOT (517) and SQLITE_BUSY_RECOVERY (261) both pack 5.
    expect(isTransientSqliteContention({ errcode: 517, message: 'busy snapshot' })).toBe(true)
    expect(isTransientSqliteContention({ errcode: 261, message: 'recovery' })).toBe(true)
  })

  it('does not treat an unreadable or absent database as contention', () => {
    expect(isTransientSqliteContention(new Error('file is not a database'))).toBe(false)
    expect(
      isTransientSqliteContention({ errcode: 14, message: 'unable to open database file' })
    ).toBe(false)
  })
})

describe('classifySqliteReadFailure', () => {
  it('classifies contention as retryable regardless of the file evidence', () => {
    const error = { errcode: 5, message: 'database is locked' }

    expect(classifySqliteReadFailure({ error, databaseFileExists: true })).toBe('contended')
    expect(classifySqliteReadFailure({ error, databaseFileExists: false })).toBe('contended')
  })

  it('classifies SQLITE_CANTOPEN against a present database as an unreachable wal-index', () => {
    expect(
      classifySqliteReadFailure({
        error: { errcode: 14, message: 'unable to open database file' },
        databaseFileExists: true
      })
    ).toBe('wal-index-unavailable')
  })

  it('does not blame the wal-index when the database file itself is gone', () => {
    expect(
      classifySqliteReadFailure({
        error: { errcode: 14, message: 'unable to open database file' },
        databaseFileExists: false
      })
    ).toBe('unreadable')
  })

  it('falls back to unreadable for anything else', () => {
    expect(
      classifySqliteReadFailure({
        error: { errcode: 11, message: 'database disk image is malformed' },
        databaseFileExists: true
      })
    ).toBe('unreadable')
  })
})
