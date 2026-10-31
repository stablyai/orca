// Scanner-owned per-transcript rows persist changes without rewriting or capping the full working set.
import { isSqliteCorruption } from '../sqlite/sqlite-read-failure'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import type SyncDatabase from '../sqlite/sync-database'
import {
  openVersionedCacheDatabase,
  removeVersionedCacheDatabase
} from '../sqlite/versioned-cache-database'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type {
  PersistedSessionParseCacheEntry,
  SessionScopeCwdLookup,
  SessionScopeCwdStamp
} from './session-parse-cache-store'
import {
  ensureScopeCwdsTable,
  readScopeCwdRows,
  writeScopeCwdRows
} from './session-scope-cwds-table'
import { parsePersistedSidecar } from './session-sidecar-stat'

// Bump for row-layout or cached-semantic changes; mismatched databases are discarded.
export const SESSION_PARSE_CACHE_SCHEMA_VERSION = 9

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

  /** Read parse and scope cwds without decoding cached sessions. */
  readScopeCwds(paths: readonly string[]) {
    const parsed = this.run((db) => readScopeCwdRows(db, paths, 'parsed'), undefined)
    const read = this.run((db) => readScopeCwdRows(db, paths, 'read'), undefined)
    const found = parsed ?? new Map<string, SessionScopeCwdLookup>()
    for (const [path, row] of read ?? []) {
      found.set(path, { ...found.get(path), ...row })
    }
    return { found, parsed: parsed !== undefined, read: read !== undefined }
  }

  writeScopeCwds(rows: Iterable<[string, SessionScopeCwdStamp]>, seenAt: number): void {
    this.run((db) => writeScopeCwdRows(db, rows, seenAt), undefined)
  }

  /** One transaction; callers chunk for event-loop fairness, and keepExisting preserves stored rows. */
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
    this.run((db) => {
      db.prepare('DELETE FROM rows WHERE path = ?').run(path)
      db.prepare('DELETE FROM scope_cwds WHERE path = ?').run(path)
    }, undefined)
  }

  /** Return stale paths oldest first so successive batches make progress. */
  pathsSeenBefore(cutoff: number, limit: number, excludeGlob: string): string[] {
    return this.run(
      (db) =>
        db
          .prepare(
            `SELECT path FROM (SELECT path, seen_at FROM rows UNION ALL SELECT path, seen_at FROM scope_cwds)
             WHERE seen_at < ? AND path NOT GLOB ? GROUP BY path ORDER BY MIN(seen_at) LIMIT ?`
          )
          .all(cutoff, excludeGlob, limit)
          .flatMap((row) => (typeof row.path === 'string' ? [row.path] : [])),
      []
    )
  }

  deleteSeenBefore(cutoff: number, glob: string): boolean {
    return this.run(
      (db) =>
        ['rows', 'scope_cwds']
          .map((table) =>
            Number(
              db.prepare(`DELETE FROM ${table} WHERE seen_at < ? AND path GLOB ?`).run(cutoff, glob)
                .changes
            )
          )
          .some((changes) => changes > 0),
      false
    )
  }

  markSeen(path: string, seenAt: number): void {
    this.run((db) => {
      db.prepare('UPDATE rows SET seen_at = ? WHERE path = ?').run(seenAt, path)
      db.prepare('UPDATE scope_cwds SET seen_at = ? WHERE path = ?').run(seenAt, path)
    }, undefined)
  }

  reclaimSpace(): void {
    this.run((db) => db.pragma('incremental_vacuum'), undefined)
  }

  close(): void {
    const db = this.db
    this.db = null
    try {
      db?.close()
    } catch {}
  }

  // Failures return misses; rebuild corruption once, then disable the database if corruption recurs.
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
    pageSize: PAGE_SIZE,
    afterSchema: ensureScopeCwdsTable
  })
  hardenSqliteDatabaseFiles(path)
  return db
}

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
