// One row per transcript, so a write costs what changed and no size cap has to
// sit below the working set (the old single JSON file needed one, and that cap
// was the gap a restart re-parsed through). Owned by the scanner child.
import { isSqliteCorruption } from '../sqlite/sqlite-read-failure'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import type SyncDatabase from '../sqlite/sync-database'
import {
  openVersionedCacheDatabase,
  removeVersionedCacheDatabase
} from '../sqlite/versioned-cache-database'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-store'
import type { SessionSidecarObservation } from './session-sidecar-stat'

// Bump when the row layout or cached session semantics change; a mismatched
// database is dropped whole.
export const SESSION_PARSE_CACHE_SCHEMA_VERSION = 4

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rows(
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER,
  platform TEXT NOT NULL,
  -- JSON, validated on read like any other untrusted file content.
  sidecar TEXT,
  session TEXT NOT NULL,
  -- Wall-clock ms the transcript was last parsed or found still on disk. Rows
  -- past an age are re-checked, which is what ends a row whose transcript was
  -- deleted outside Orca.
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rows_seen_at ON rows(seen_at);
`
// Rows hold transcript-derived preview text; keep the directory user-only.
const PRIVATE_DIRECTORY_MODE = 0o700
// A ~2.3 KB row fills most of a 4 KB page; 8 KB pages fit three.
const PAGE_SIZE = 8192

export class SessionParseCacheDatabase {
  private db: SyncDatabase | null
  private recovered = false

  constructor(private readonly path: string) {
    this.db = openDatabase(path)
  }

  read(path: string): PersistedSessionParseCacheEntry | undefined {
    return this.run((db) => {
      const row = db
        .prepare('SELECT mtime_ms, size_bytes, platform, sidecar, session FROM rows WHERE path = ?')
        .get(path)
      if (row === undefined) {
        return undefined
      }
      const entry = parsePersistedSessionParseCacheRow([
        path,
        {
          mtimeMs: row.mtime_ms,
          sizeBytes: row.size_bytes,
          platform: row.platform,
          sidecar: typeof row.sidecar === 'string' ? JSON.parse(row.sidecar) : undefined,
          session: typeof row.session === 'string' ? JSON.parse(row.session) : undefined
        }
      ])
      return entry?.[1]
    }, undefined)
  }

  /**
   * One transaction; a caller chunks large writes so the event loop gets turns
   * between them. `keepExisting` leaves rows already present untouched.
   */
  write(
    rows: Iterable<[string, PersistedSessionParseCacheEntry]>,
    seenAt: number,
    keepExisting = false
  ): void {
    this.run((db) => {
      const insert = db.prepare(
        `INSERT OR ${keepExisting ? 'IGNORE' : 'REPLACE'} INTO rows(path, mtime_ms, size_bytes, platform, sidecar, session, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const [path, entry] of rows) {
          insert.run(
            path,
            entry.mtimeMs,
            entry.sizeBytes,
            entry.platform,
            entry.sidecar === undefined ? null : JSON.stringify(entry.sidecar),
            JSON.stringify(entry.session),
            seenAt
          )
        }
        db.exec('COMMIT')
      } catch (error) {
        if (db.isTransaction) {
          db.exec('ROLLBACK')
        }
        throw error
      }
    }, undefined)
  }

  delete(path: string): void {
    this.run((db) => db.prepare('DELETE FROM rows WHERE path = ?').run(path), undefined)
  }

  /** Oldest first, so repeated calls work through every stale row outside `excludeGlob`. */
  pathsSeenBefore(cutoff: number, limit: number, excludeGlob: string): string[] {
    return this.run(
      (db) =>
        db
          .prepare(
            'SELECT path FROM rows WHERE seen_at < ? AND path NOT GLOB ? ORDER BY seen_at LIMIT ?'
          )
          .all(cutoff, excludeGlob, limit)
          .flatMap((row) => (typeof row.path === 'string' ? [row.path] : [])),
      []
    )
  }

  /** True when any row was deleted. */
  deleteSeenBefore(cutoff: number, glob: string): boolean {
    return this.run(
      (db) =>
        Number(
          db.prepare('DELETE FROM rows WHERE seen_at < ? AND path GLOB ?').run(cutoff, glob).changes
        ) > 0,
      false
    )
  }

  markSeen(path: string, seenAt: number): void {
    this.run(
      (db) => db.prepare('UPDATE rows SET seen_at = ? WHERE path = ?').run(seenAt, path),
      undefined
    )
  }

  /** Hands freed pages back to the file system after deletes. */
  reclaimSpace(): void {
    this.run((db) => db.pragma('incremental_vacuum'), undefined)
  }

  close(): void {
    const db = this.db
    this.db = null
    try {
      db?.close()
    } catch {
      // Already closed by a failed statement; nothing left to release.
    }
  }

  // Every failure is a miss, so History only ever pays a re-parse. SQLite can
  // report a torn page at any statement, not only at open: rebuild once, then
  // stay memory-only for this process rather than retry per lookup.
  private run<T>(operation: (db: SyncDatabase) => T, fallback: T): T {
    const db = this.db
    if (db === null) {
      return fallback
    }
    try {
      return operation(db)
    } catch (error) {
      console.debug('[ai-vault] session parse cache database failed', error)
      if (isSqliteCorruption(error)) {
        this.close()
        if (!this.recovered) {
          this.recovered = true
          try {
            removeVersionedCacheDatabase(this.path)
            this.db = openDatabase(this.path)
          } catch (reopenError) {
            console.debug('[ai-vault] session parse cache database stays off', reopenError)
          }
        }
      }
      return fallback
    }
  }
}

function openDatabase(path: string): SyncDatabase {
  const db = openVersionedCacheDatabase(path, {
    version: SESSION_PARSE_CACHE_SCHEMA_VERSION,
    sql: SCHEMA_SQL,
    directoryMode: PRIVATE_DIRECTORY_MODE,
    pageSize: PAGE_SIZE
  })
  hardenSqliteDatabaseFiles(path)
  return db
}

/** Validates one `[path, entry]` row read back from disk; null when it can't be trusted. */
export function parsePersistedSessionParseCacheRow(
  item: unknown
): [string, PersistedSessionParseCacheEntry] | null {
  if (!Array.isArray(item) || item.length !== 2) {
    return null
  }
  const [path, entry]: unknown[] = item
  if (typeof path !== 'string' || !isRecord(entry)) {
    return null
  }
  const { mtimeMs, sizeBytes, platform, session } = entry
  if (
    typeof mtimeMs !== 'number' ||
    (sizeBytes !== null && typeof sizeBytes !== 'number') ||
    typeof platform !== 'string' ||
    (session !== null && !isRecord(session))
  ) {
    return null
  }
  const sidecar = parsePersistedSidecar(entry.sidecar)
  return [
    path,
    {
      mtimeMs,
      sizeBytes,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only ever compared for equality with process.platform, so an unknown value is a miss, not a misuse.
      platform: platform as NodeJS.Platform,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written only from AiVaultSession values by this build or one with the same schema version; a semantics change bumps the version and drops the rows.
      session: session as AiVaultSession | null,
      ...(sidecar === undefined ? {} : { sidecar })
    }
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Why: added after SCHEMA_VERSION 2 shipped, so a row an older build wrote has
// no such field. Absent (or unreadable) means unknown, which costs one re-parse
// of the rows that have a sibling and nothing at all for the rest.
function parsePersistedSidecar(value: unknown): SessionSidecarObservation | undefined {
  if (value === 'none' || value === 'unknown') {
    return value
  }
  if (!isRecord(value)) {
    return undefined
  }
  const { path, mtimeMs, sizeBytes } = value
  return typeof path === 'string' && typeof mtimeMs === 'number' && typeof sizeBytes === 'number'
    ? { path, mtimeMs, sizeBytes }
    : undefined
}
