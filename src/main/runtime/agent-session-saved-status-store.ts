// Each chat's last settled status, kept across a restart so the host can list a chat without
// replaying its journal. A cache: every entry is checked against its journal's position before it
// is used, so a lost or stale write costs one journal open and nothing else.
//
// Writes are coalesced and never on the hot path: the status memo recomputes on every journal
// move, so an entry only joins an in-memory dirty map, and a short timer writes the map in one
// transaction. A lock held by another process is a skip the next flush retries, never a wait on
// the main thread.

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { StructuredAgentSessionSavedStatus } from '../../shared/structured-agent-session-saved-status'
import { parseStructuredAgentSessionSavedProjection } from '../../shared/structured-agent-session-saved-status'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import { isUnusableSqliteDatabaseError } from '../sqlite/sqlite-read-failure'
import Database from '../sqlite/sync-database'

export const AGENT_SESSION_SAVED_STATUS_FILE = 'agent-session-saved-status.db'
const SCHEMA_VERSION = 1
const FLUSH_DELAY_MS = 250

const CREATE_TABLE = `CREATE TABLE saved_status (
  session_id       TEXT PRIMARY KEY,
  v                INTEGER NOT NULL,
  epoch            TEXT    NOT NULL,
  sequence         INTEGER NOT NULL,
  projection_json  TEXT    NOT NULL,
  last_activity_at INTEGER NOT NULL
)`
const SELECT_ONE =
  'SELECT v, epoch, sequence, projection_json, last_activity_at FROM saved_status WHERE session_id = ?'
const UPSERT = `INSERT INTO saved_status
  (session_id, v, epoch, sequence, projection_json, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET v = excluded.v, epoch = excluded.epoch,
  sequence = excluded.sequence, projection_json = excluded.projection_json,
  last_activity_at = excluded.last_activity_at`
const SELECT_IDS = 'SELECT session_id FROM saved_status'
const DELETE_ONE = 'DELETE FROM saved_status WHERE session_id = ?'

function warn(message: string, error: unknown): void {
  console.warn(`[agent-session-saved-status] ${message}`, error)
}

/** Null disables the store for this run: a newer build's file is left untouched. */
function openDatabase(path: string): Database.Database | null {
  const db = new Database(path)
  try {
    // Read before any pragma that writes: a newer build's file must stay byte-identical.
    const stored = Number(db.pragma('user_version', { simple: true }) ?? 0)
    if (stored > SCHEMA_VERSION) {
      db.close()
      return null
    }
    db.pragma('journal_mode = WAL')
    // A lost write costs a miss, so a commit needs no fsync, and a busy lock is a skip.
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 0')
    if (stored < SCHEMA_VERSION) {
      db.exec('BEGIN IMMEDIATE')
      db.exec(`DROP TABLE IF EXISTS saved_status; ${CREATE_TABLE}`)
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    }
    hardenSqliteDatabaseFiles(path)
    return db
  } catch (error) {
    try {
      db.close()
    } catch {
      // The open already failed; its error is the one worth reporting.
    }
    throw error
  }
}

function removeDatabaseFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    rmSync(file, { force: true })
  }
}

export class AgentSessionSavedStatusStore {
  private readonly dirty = new Map<string, StructuredAgentSessionSavedStatus>()
  private timer: ReturnType<typeof setTimeout> | null = null

  private constructor(
    private readonly path: string,
    private db: Database.Database | null
  ) {}

  /** Never throws: a store that cannot open runs disabled, and every chat misses. */
  static open(stateDirectory: string): AgentSessionSavedStatusStore {
    const path = join(stateDirectory, AGENT_SESSION_SAVED_STATUS_FILE)
    return new AgentSessionSavedStatusStore(path, AgentSessionSavedStatusStore.openOrRecreate(path))
  }

  /** A corrupt file is deleted and recreated, never left to disable the store for good. */
  private static openOrRecreate(path: string): Database.Database | null {
    try {
      return openDatabase(path)
    } catch (error) {
      if (!isUnusableSqliteDatabaseError(error)) {
        warn('open failed; saved statuses are off for this run', error)
        return null
      }
      try {
        removeDatabaseFiles(path)
        return openDatabase(path)
      } catch (recreateError) {
        warn('recreating an unusable file failed', recreateError)
        return null
      }
    }
  }

  get enabled(): boolean {
    return this.db !== null
  }

  read(sessionId: string): StructuredAgentSessionSavedStatus | null {
    const pending = this.dirty.get(sessionId)
    if (pending) {
      return pending
    }
    try {
      const row = this.db?.prepare(SELECT_ONE).get(sessionId)
      const projection =
        typeof row?.projection_json === 'string'
          ? parseStructuredAgentSessionSavedProjection(row.projection_json)
          : null
      if (
        !row ||
        !projection ||
        typeof row.v !== 'number' ||
        typeof row.epoch !== 'string' ||
        typeof row.sequence !== 'number' ||
        typeof row.last_activity_at !== 'number'
      ) {
        return null
      }
      return {
        v: row.v,
        cursor: { epoch: row.epoch, sequence: row.sequence },
        projection,
        lastActivityAt: row.last_activity_at
      }
    } catch (error) {
      warn('read failed', error)
      return null
    }
  }

  /** Coalesced: the latest entry per chat is written by the next flush. */
  record(sessionId: string, saved: StructuredAgentSessionSavedStatus): void {
    if (!this.db) {
      return
    }
    this.dirty.set(sessionId, saved)
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_DELAY_MS)
    this.timer.unref?.()
  }

  /** Writes every dirty entry in one transaction. False when the write was skipped; the entries
   *  stay dirty for the next flush. */
  flush(): boolean {
    const db = this.db
    if (!db || this.dirty.size === 0) {
      return true
    }
    const entries = [...this.dirty]
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const upsert = db.prepare(UPSERT)
        for (const [sessionId, saved] of entries) {
          upsert.run(
            sessionId,
            saved.v,
            saved.cursor.epoch,
            saved.cursor.sequence,
            JSON.stringify(saved.projection),
            saved.lastActivityAt
          )
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      warn('flush skipped; the next flush retries', error)
      if (isUnusableSqliteDatabaseError(error)) {
        this.recreate()
      }
      return false
    }
    for (const [sessionId, saved] of entries) {
      if (this.dirty.get(sessionId) === saved) {
        this.dirty.delete(sessionId)
      }
    }
    return true
  }

  /** Drops entries for chats that no longer exist, so the table stays bounded by the records. */
  prune(keep: (sessionId: string) => boolean): void {
    for (const sessionId of this.dirty.keys()) {
      if (!keep(sessionId)) {
        this.dirty.delete(sessionId)
      }
    }
    const db = this.db
    if (!db) {
      return
    }
    try {
      const stale = db
        .prepare(SELECT_IDS)
        .all()
        .map((row) => row.session_id)
        .filter((sessionId): sessionId is string => typeof sessionId === 'string')
        .filter((sessionId) => !keep(sessionId))
      if (stale.length === 0) {
        return
      }
      db.exec('BEGIN IMMEDIATE')
      const remove = db.prepare(DELETE_ONE)
      for (const sessionId of stale) {
        remove.run(sessionId)
      }
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) {
        db.exec('ROLLBACK')
      }
      warn('prune skipped', error)
    }
  }

  /** Flushes, then closes. After host teardown, so teardown's own settlements are written. */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
    try {
      this.db?.close()
    } catch (error) {
      warn('close failed', error)
    }
    this.db = null
  }

  private recreate(): void {
    try {
      this.db?.close()
    } catch {
      // The file is being replaced; its handle has nothing left to lose.
    }
    try {
      removeDatabaseFiles(this.path)
      this.db = openDatabase(this.path)
    } catch (error) {
      warn('recreating an unusable file failed', error)
      this.db = null
    }
  }
}
