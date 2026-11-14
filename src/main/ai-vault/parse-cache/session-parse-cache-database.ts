import { parseSessionCopyProofRow } from './session-copy-proof-database'
import type { SessionCopyProof } from './session-copy-proof'
import {
  parseSessionCacheIdentity,
  parsePersistedSessionParseCacheRow
} from './session-cache-evidence'
export { parsePersistedSessionParseCacheRow } from './session-cache-evidence'
import { sessionFileIdentity } from './session-file-version'
import { startSpan } from '../../observability/tracer'
// Scanner-owned per-transcript rows persist changes without rewriting or capping the full working set.
import { isSqliteCorruption } from '../../sqlite/sqlite-read-failure'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import type SyncDatabase from '../../sqlite/sync-database'
import {
  openVersionedCacheDatabase,
  removeVersionedCacheDatabase
} from '../../sqlite/versioned-cache-database'
import type {
  PersistedSessionParseCacheEntry,
  SessionScopeCwdLookup,
  SessionScopeCwdStamp
} from './session-parse-cache-store'
import {
  ensureScopeCwdsTable,
  readScopeCwdRows,
  writeScopeCwdRows,
  writeSessionCacheTable
} from './session-scope-cwds-table'

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
  skipped_records TEXT NOT NULL,
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
        .prepare(
          'SELECT mtime_ms, size_bytes, platform, identity, sidecar, session, skipped_records FROM rows WHERE path = ?'
        )
        .get(path)
      if (row === undefined) {
        return undefined
      }
      const entry = parsePersistedSessionParseCacheRow([
        path,
        {
          ...parseSessionCacheIdentity(row.identity),
          mtimeMs: row.mtime_ms,
          sizeBytes: row.size_bytes,
          platform: row.platform,
          sidecar: typeof row.sidecar === 'string' ? JSON.parse(row.sidecar) : undefined,
          session: typeof row.session === 'string' ? JSON.parse(row.session) : undefined,
          skippedRecords:
            typeof row.skipped_records === 'string' ? JSON.parse(row.skipped_records) : undefined
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
      writeSessionCacheTable(
        db,
        `INSERT OR ${keepExisting ? 'IGNORE' : 'REPLACE'} INTO rows(path, mtime_ms, size_bytes, platform, identity, sidecar, session, skipped_records, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        Array.from(rows, ([path, entry]) => [
          path,
          entry.mtimeMs,
          entry.sizeBytes,
          entry.platform,
          JSON.stringify(sessionFileIdentity(entry)),
          entry.sidecar === undefined ? null : JSON.stringify(entry.sidecar),
          JSON.stringify(entry.session),
          JSON.stringify(entry.skippedRecords ?? []),
          seenAt
        ])
      )
    }, undefined)
  }

  readCopyProof(path: string): SessionCopyProof | undefined {
    return this.run(
      (db) =>
        parseSessionCopyProofRow(
          db
            .prepare(
              'SELECT mtime_ms, size_bytes, identity, session_id FROM copy_proofs WHERE path = ?'
            )
            .get(path)
        ),
      undefined
    )
  }

  writeCopyProofs(rows: Iterable<[string, SessionCopyProof]>, seenAt: number): void {
    this.run(
      (db) =>
        writeSessionCacheTable(
          db,
          'INSERT OR REPLACE INTO copy_proofs(path, mtime_ms, size_bytes, identity, session_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
          Array.from(rows, ([path, proof]) => [
            path,
            proof.mtimeMs,
            proof.sizeBytes,
            JSON.stringify(sessionFileIdentity(proof)),
            proof.sessionId,
            seenAt
          ])
        ),
      undefined
    )
  }

  delete(path: string): void {
    this.run((db) => {
      for (const table of ['rows', 'scope_cwds', 'copy_proofs']) {
        db.prepare(`DELETE FROM ${table} WHERE path = ?`).run(path)
      }
    }, undefined)
  }

  /** Return stale paths oldest first so successive batches make progress. */
  pathsSeenBefore(cutoff: number, limit: number, excludeGlob: string): string[] {
    return this.run(
      (db) =>
        db
          .prepare(
            `SELECT path FROM (SELECT path, seen_at FROM rows UNION ALL SELECT path, seen_at FROM scope_cwds UNION ALL SELECT path, seen_at FROM copy_proofs)
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
        ['rows', 'scope_cwds', 'copy_proofs']
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
      for (const table of ['rows', 'scope_cwds', 'copy_proofs']) {
        db.prepare(`UPDATE ${table} SET seen_at = ? WHERE path = ?`).run(seenAt, path)
      }
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
    const span = startSpan('aiVault.parseCache.sqlite')
    try {
      return operation(db)
    } catch (error) {
      span.fail(error instanceof Error ? error : String(error))
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
    } finally {
      span.end()
    }
  }
}

function openDatabase(path: string): SyncDatabase {
  const db = openVersionedCacheDatabase(path, {
    version: SESSION_PARSE_CACHE_SCHEMA_VERSION,
    sql: SCHEMA_SQL,
    directoryMode: PRIVATE_DIRECTORY_MODE,
    pageSize: PAGE_SIZE,
    afterSchema: (db) => {
      ensureScopeCwdsTable(db)
      ensureSessionCacheEvidence(db)
    }
  })
  hardenSqliteDatabaseFiles(path)
  return db
}

/** Add reconstructible evidence without invalidating independently owned parser checkpoints. */
function ensureSessionCacheEvidence(db: SyncDatabase): void {
  for (const table of ['rows', 'scope_cwds']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!columns.some((column) => column.name === 'identity')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN identity TEXT`)
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS copy_proofs(
    path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size_bytes INTEGER,
    identity TEXT, session_id TEXT NOT NULL, seen_at INTEGER NOT NULL
  )`)
}
