import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from './sync-database'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

export type VersionedCacheDatabaseSchema = {
  version: number
  // Idempotent DDL, including `meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // which holds the schema version.
  sql: string
  // Runs inside the same rebuild-on-corruption scope as the schema.
  afterSchema?: (db: SyncDatabase) => void
  // SQLite will not create the directory; this is its mode when this call does.
  directoryMode?: number
  // Applies only to a new file; rows near half a default page waste the other half.
  pageSize?: number
}

/**
 * Opens a SQLite cache, rebuilding it whenever what is on disk cannot be trusted:
 * a different schema version, a version SQLite cannot report, or a file torn
 * badly enough that opening or recovery fails. The database is a cache over
 * files the user owns, so throwing away a bad one costs a re-read and nothing
 * else; refusing to open would strand the feature until a human deleted the file.
 */
export function openVersionedCacheDatabase(
  path: string,
  schema: VersionedCacheDatabaseSchema
): SyncDatabase {
  // SQLite will not create the directory, and its failure is `unable to open
  // database file`, which is correctly not corruption — so without this the
  // feature strands on a profile that has never held the database.
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: schema.directoryMode })
  }
  try {
    return openExisting(path, schema)
  } catch (error) {
    if (!isUnusableDatabaseError(error)) {
      throw error
    }
    // One retry only: a second failure on a file we just created is not corruption.
    removeVersionedCacheDatabase(path)
    return openExisting(path, schema)
  }
}

function openExisting(path: string, schema: VersionedCacheDatabaseSchema): SyncDatabase {
  // Nulled while no handle is open, because closing an already-closed handle
  // throws ERR_INVALID_STATE, which would replace whatever really failed —
  // an unlink refused by a virus scanner or a second Orca holding the file —
  // with an error nothing classifies as worth rebuilding for.
  let db: SyncDatabase | null = openWithPragmas(path, schema.pageSize)
  try {
    if (isStaleSchema(db, schema.version)) {
      // Why: DROP TABLE on a multi-GB table takes minutes and runs inside the
      // scanner service's init, past its ready timeout; unlinking is instant.
      db.close()
      db = null
      removeVersionedCacheDatabase(path)
      db = openWithPragmas(path, schema.pageSize)
    }
    db.exec(schema.sql)
    schema.afterSchema?.(db)
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'schema_version',
      String(schema.version)
    )
    return db
  } catch (error) {
    db?.close()
    throw error
  }
}

// SQLite reports a torn file at the first statement that has to read a page, so
// this has to match on the message as well as the code.
const UNUSABLE_DATABASE =
  /SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database|database disk image is malformed/i

function isUnusableDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = 'code' in error ? error.code : undefined
  return (
    (typeof code === 'string' && UNUSABLE_DATABASE.test(code)) ||
    UNUSABLE_DATABASE.test(error.message)
  )
}

function openWithPragmas(path: string, pageSize: number | undefined): SyncDatabase {
  const db = new SyncDatabase(path)
  try {
    // First, so switching to WAL below waits out another process's lock instead of failing.
    db.pragma('busy_timeout = 5000')
    if (pageSize !== undefined) {
      db.pragma(`page_size = ${pageSize}`)
    }
    // Why: only takes effect on an empty file; it is what lets a purge hand pages
    // back in bounded steps instead of a full VACUUM. Set before any table exists.
    db.pragma('auto_vacuum = INCREMENTAL')
    // A writer's rows land in one transaction, and a reader on another handle
    // sees the last committed state rather than a write half way through.
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('journal_size_limit = 8388608')
    return db
  } catch (error) {
    db?.close()
    throw error
  }
}

export function removeVersionedCacheDatabase(path: string): void {
  if (path === ':memory:') {
    return
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    removeTreeSync(`${path}${suffix}`)
  }
}

/**
 * Whether what is on disk has to be thrown away. No `meta` table at all is a
 * file with nothing in it to throw away, and removing it would make the first
 * open of every new profile a create-remove-create. A meta table whose version
 * row is missing or unparseable is a damaged cache rather than a new one:
 * seeding the current version over it would keep whatever rows the old schema
 * left.
 */
function isStaleSchema(db: SyncDatabase, version: number): boolean {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get()
  if (!table) {
    return false
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  return (typeof row?.value === 'string' ? Number(row.value) : Number.NaN) !== version
}
