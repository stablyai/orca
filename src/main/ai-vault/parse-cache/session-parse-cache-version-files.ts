import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isTransientSqliteContention } from '../../sqlite/sqlite-read-failure'
import SyncDatabase from '../../sqlite/sync-database'
import { removeVersionedCacheDatabase } from '../../sqlite/versioned-cache-database'
import { SESSION_PARSE_CACHE_SCHEMA_VERSION } from './session-parse-cache-database'

// Builds before per-version files used this name, and still do.
const UNVERSIONED_NAME = 'session-parse-cache.sqlite'
const CACHE_FILE_NAME = /^session-parse-cache(?:\.v\d+)?\.sqlite$/
// Builds on other schema versions (a downgrade, or dev and installed builds) share userData; keep the latest one warm.
const RETAINED_OTHER_VERSIONS = 1

/** One file per schema version, so opening another build never discards this build's rows. */
export function sessionParseCacheDatabasePath(directory: string): string {
  return join(directory, `session-parse-cache.v${SESSION_PARSE_CACHE_SCHEMA_VERSION}.sqlite`)
}

/** Copy a pre-versioning file that is already on this schema, so upgrading reparses nothing. */
export function adoptUnversionedSessionParseCache(directory: string, path: string): void {
  const unversioned = join(directory, UNVERSIONED_NAME)
  if (existsSync(path) || !existsSync(unversioned)) {
    return
  }
  // Snapshot into a private file first: a build still using the old file keeps it untouched.
  const staging = `${path}.adopting`
  try {
    rmSync(staging, { force: true })
    const db = new SyncDatabase(unversioned, { readonly: true })
    let copied = false
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      if (row?.value === String(SESSION_PARSE_CACHE_SCHEMA_VERSION)) {
        db.prepare('VACUUM INTO ?').run(staging)
        copied = true
      }
    } finally {
      db.close()
    }
    if (copied) {
      renameSync(staging, path)
    }
  } catch {
    // Unreadable or busy: this version starts cold and the old file is pruned like any other.
    rmSync(staging, { force: true })
  }
}

/** Keep this version and the most recently used other one; the rest only cost disk. */
export function pruneOtherSessionParseCacheVersions(directory: string, path: string): void {
  let others: { path: string; usedAt: number }[]
  try {
    others = readdirSync(directory)
      .filter((name) => CACHE_FILE_NAME.test(name))
      .map((name) => join(directory, name))
      .filter((other) => other !== path)
      .map((other) => ({ path: other, usedAt: lastWrittenAt(other) }))
  } catch {
    return
  }
  others.sort((left, right) => right.usedAt - left.usedAt)
  for (const stale of others.slice(RETAINED_OTHER_VERSIONS)) {
    if (openElsewhere(stale.path)) {
      continue
    }
    try {
      removeVersionedCacheDatabase(stale.path, 'fail-fast')
    } catch {
      // A later start retries.
    }
  }
}

// Leaving WAL needs every other connection closed; unlinking a live file would strand its build's writes.
function openElsewhere(path: string): boolean {
  try {
    const db = new SyncDatabase(path)
    try {
      return db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete'
    } finally {
      db.close()
    }
  } catch (error) {
    return isTransientSqliteContention(error)
  }
}

// WAL mode writes land in -wal first; the main file changes only on checkpoint.
function lastWrittenAt(path: string): number {
  let latest = 0
  for (const suffix of ['', '-wal']) {
    try {
      latest = Math.max(latest, statSync(`${path}${suffix}`).mtimeMs)
    } catch {
      // A missing WAL is normal after a clean close.
    }
  }
  return latest
}
