import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import {
  BACKFILL_PENDING_MIN_SESSION_FILES,
  countCodexSessionFilesUpTo,
  findNewestCodexStateDbPath,
  isCodexBackfillIndexPending,
  readCodexStateDbBackfillStatus
} from './codex-state-db'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-codex-state-db-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function createStateDb(name: string, status?: string): string {
  const dbPath = join(home, name)
  const db = new DatabaseSync(dbPath)
  if (status !== undefined) {
    db.exec(
      `CREATE TABLE backfill_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL,
        last_watermark TEXT,
        last_success_at INTEGER,
        updated_at INTEGER NOT NULL
      )`
    )
    db.prepare('INSERT INTO backfill_state (id, status, updated_at) VALUES (1, ?, ?)').run(
      status,
      Date.now()
    )
  }
  db.close()
  return dbPath
}

function writeStateDb(home: string, status: string, lastWatermark: string | null): void {
  const db = new SyncDatabase(join(home, 'state_5.sqlite'))
  db.exec(
    'CREATE TABLE backfill_state (id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL, last_watermark TEXT, last_success_at INTEGER, updated_at INTEGER NOT NULL)'
  )
  db.prepare(
    'INSERT INTO backfill_state (id, status, last_watermark, last_success_at, updated_at) VALUES (1, ?, ?, NULL, 0)'
  ).run(status, lastWatermark)
  db.close()
}

function seedSessionFiles(home: string, count: number): void {
  const dir = join(home, 'sessions', '2026', '07', '01')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `rollout-${i}.jsonl`), '{}\n')
  }
}

describe('findNewestCodexStateDbPath', () => {
  it('returns null when the home has no state db', () => {
    expect(findNewestCodexStateDbPath(home)).toBeNull()
  })

  it('returns null when the home directory does not exist', () => {
    expect(findNewestCodexStateDbPath(join(home, 'nope'))).toBeNull()
  })

  it('picks the highest schema version', () => {
    createStateDb('state_5.sqlite', 'complete')
    const newest = createStateDb('state_12.sqlite', 'running')
    createStateDb('state_9.sqlite', 'complete')
    expect(findNewestCodexStateDbPath(home)).toBe(newest)
  })

  it('ignores non-matching filenames like state_5.sqlite-wal', () => {
    createStateDb('state_5.sqlite', 'complete')
    writeFileSync(join(home, 'state_6.sqlite-wal'), '')
    writeFileSync(join(home, 'logs_2.sqlite'), '')
    expect(findNewestCodexStateDbPath(home)).toBe(join(home, 'state_5.sqlite'))
  })
})

describe('readCodexStateDbBackfillStatus', () => {
  it('reports missing when no state db exists', () => {
    expect(readCodexStateDbBackfillStatus(home)).toEqual({ kind: 'missing' })
  })

  it('reports complete', () => {
    const dbPath = createStateDb('state_5.sqlite', 'complete')
    expect(readCodexStateDbBackfillStatus(home)).toEqual({ kind: 'complete', stateDbPath: dbPath })
  })

  it('reports incomplete with the raw status for running/pending', () => {
    const dbPath = createStateDb('state_5.sqlite', 'running')
    expect(readCodexStateDbBackfillStatus(home)).toEqual({
      kind: 'incomplete',
      stateDbPath: dbPath,
      status: 'running',
      lastWatermark: null
    })
  })

  it('exposes the backfill cursor on incomplete status', () => {
    writeStateDb(home, 'running', 'sessions/2026/07/02/rollout-x.jsonl')
    const status = readCodexStateDbBackfillStatus(home)
    expect(status).toEqual({
      kind: 'incomplete',
      stateDbPath: join(home, 'state_5.sqlite'),
      status: 'running',
      lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl'
    })
  })

  it('reports null cursor when last_watermark is NULL', () => {
    writeStateDb(home, 'pending', null)
    const status = readCodexStateDbBackfillStatus(home)
    expect(status).toMatchObject({ kind: 'incomplete', lastWatermark: null })
  })

  it('reports not-tracked when the backfill_state table is absent', () => {
    const dbPath = createStateDb('state_5.sqlite')
    expect(readCodexStateDbBackfillStatus(home)).toEqual({
      kind: 'not-tracked',
      stateDbPath: dbPath
    })
  })

  it('reports unreadable for a corrupt file', () => {
    const dbPath = join(home, 'state_5.sqlite')
    writeFileSync(dbPath, 'this is not a sqlite database at all')
    const result = readCodexStateDbBackfillStatus(home)
    expect(result.kind).toBe('unreadable')
  })
})

describe('isCodexBackfillIndexPending', () => {
  it('pending: true for any incomplete status regardless of history size', () => {
    writeStateDb(home, 'running', null)
    expect(isCodexBackfillIndexPending(home)).toBe(true)
  })

  it('pending: false for complete', () => {
    writeStateDb(home, 'complete', null)
    expect(isCodexBackfillIndexPending(home)).toBe(false)
  })

  it('pending: true for a missing state db over a large history', () => {
    seedSessionFiles(home, BACKFILL_PENDING_MIN_SESSION_FILES)
    expect(isCodexBackfillIndexPending(home)).toBe(true)
  })

  it('pending: false for a missing state db over a small history', () => {
    seedSessionFiles(home, BACKFILL_PENDING_MIN_SESSION_FILES - 1)
    expect(isCodexBackfillIndexPending(home)).toBe(false)
  })

  it('pending: false (fail open) when the state db is unreadable', () => {
    writeFileSync(join(home, 'state_5.sqlite'), 'not a database')
    seedSessionFiles(home, BACKFILL_PENDING_MIN_SESSION_FILES)
    expect(isCodexBackfillIndexPending(home)).toBe(false)
  })
})

describe('countCodexSessionFilesUpTo', () => {
  it('returns 0 for a missing sessions root', () => {
    expect(countCodexSessionFilesUpTo(join(home, 'sessions'), 10)).toBe(0)
  })

  it('counts nested .jsonl files and stops at the limit', () => {
    const day = join(home, 'sessions', '2026', '07', '31')
    mkdirSync(day, { recursive: true })
    for (let i = 0; i < 7; i += 1) {
      writeFileSync(join(day, `rollout-${i}.jsonl`), '')
    }
    writeFileSync(join(day, 'not-a-session.txt'), '')
    expect(countCodexSessionFilesUpTo(join(home, 'sessions'), 100)).toBe(7)
    expect(countCodexSessionFilesUpTo(join(home, 'sessions'), 3)).toBe(3)
  })
})
