import { existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

/** Move a pre-versioning file that is already on this schema, so upgrading reparses nothing. */
export function adoptUnversionedSessionParseCache(directory: string, path: string): void {
  const unversioned = join(directory, UNVERSIONED_NAME)
  if (existsSync(path) || !existsSync(unversioned)) {
    return
  }
  try {
    const db = new SyncDatabase(unversioned)
    let current = false
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      current = row?.value === String(SESSION_PARSE_CACHE_SCHEMA_VERSION)
      if (current) {
        // Fold the WAL in so the moved file holds every committed row on its own.
        db.pragma('wal_checkpoint(TRUNCATE)')
      }
    } finally {
      db.close()
    }
    if (current) {
      renameSync(unversioned, path)
      removeVersionedCacheDatabase(unversioned, 'fail-fast')
    }
  } catch {
    // Unreadable or locked: it is pruned like any other version and this one starts cold.
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
    try {
      removeVersionedCacheDatabase(stale.path, 'fail-fast')
    } catch {
      // Another build may hold it open (Windows); a later start retries.
    }
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
