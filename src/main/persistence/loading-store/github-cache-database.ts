import { dirname, join } from 'node:path'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type SyncDatabase from '../../sqlite/sync-database'
import {
  isUnusableDatabaseError,
  openVersionedCacheDatabase,
  removeVersionedCacheDatabase
} from '../../sqlite/versioned-cache-database'
import { retireGitHubCacheSidecar, sha256 } from './github-cache-sidecar'

type GitHubCache = PersistedState['githubCache']
type GitHubCacheKind = keyof GitHubCache

/**
 * Next-launch copy of the PR/issue caches, one row per entry. A save rewrites only entries
 * whose content changed; the JSON sidecar it replaces was rewritten whole on every flush.
 * Disposable: a corrupt or mismatched database rebuilds empty and the next poll refills it.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries(
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(kind, key)
) WITHOUT ROWID;
`

/** Main-thread callers never wait out another writer's lock; they retry later instead. */
export const GITHUB_CACHE_ROUTINE_BUSY_TIMEOUT_MS = 25
/** Quit and explicit barriers may wait briefly so a transient lock does not drop the save. */
export const GITHUB_CACHE_BARRIER_BUSY_TIMEOUT_MS = 500

export const GITHUB_CACHE_SCHEMA_VERSION = 1

const KINDS: readonly GitHubCacheKind[] = ['pr', 'issue']

export function getGithubCacheDatabaseFile(dataFile: string): string {
  return join(dirname(dataFile), 'orca-github-cache.db')
}

export const IMPORTED_SIDECAR_KEY = 'imported_sidecar_sha256'

/**
 * Save the cache, writing only rows whose content changed. `importedLegacyFileHash` names the
 * sidecar whose content `cache` already holds (imported or superseded): the commit records it,
 * then the returned promise removes the sidecar if it is still that file. If removal never
 * happens (quit, failure), the recorded fingerprint keeps it from shadowing these rows.
 * Throws synchronously on a failed commit, including SQLITE_BUSY.
 */
export function writeGitHubCacheDatabase(
  dataFile: string,
  cache: GitHubCache,
  options: { busyTimeoutMs: number; importedLegacyFileHash: string | null }
): Promise<void> {
  const path = getGithubCacheDatabaseFile(dataFile)
  const imported = options.importedLegacyFileHash
  withCacheDatabase(path, options.busyTimeoutMs, (db) => writeEntries(db, cache, imported))
  return imported === null ? Promise.resolve() : retireGitHubCacheSidecar(dataFile, imported)
}

export function isGitHubCacheBusyError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : ''
  return /SQLITE_BUSY|SQLITE_LOCKED/.test(code) || /database (is|table is) locked/i.test(message)
}

/**
 * Open, run, close: no handle outlives a call (profile moves, Windows). Corruption found
 * anywhere, including in the rows, rebuilds the database once; lock and permission errors
 * propagate unchanged so the caller retries later.
 */
function withCacheDatabase<T>(
  path: string,
  busyTimeoutMs: number,
  run: (db: SyncDatabase) => T
): T {
  // Fail-fast removal: a rebuild blocked by a held file throws to the caller's retry.
  const schema = {
    version: GITHUB_CACHE_SCHEMA_VERSION,
    sql: SCHEMA_SQL,
    busyTimeoutMs,
    removal: 'fail-fast' as const
  }
  for (let attempt = 0; ; attempt++) {
    let db: SyncDatabase | null = null
    try {
      db = openVersionedCacheDatabase(path, schema)
      return run(db)
    } catch (error) {
      if (attempt > 0 || !isUnusableDatabaseError(error)) {
        throw error
      }
      db?.close()
      db = null
      removeVersionedCacheDatabase(path, 'fail-fast')
    } finally {
      db?.close()
    }
  }
}

export function readGitHubCacheEntries(db: SyncDatabase): GitHubCache {
  const cache: GitHubCache = { pr: {}, issue: {} }
  for (const row of db.prepare('SELECT kind, key, payload FROM entries').all()) {
    const kind = KINDS.find((candidate) => candidate === row.kind)
    if (!kind || typeof row.key !== 'string' || typeof row.payload !== 'string') {
      continue
    }
    try {
      Object.assign(cache[kind], { [row.key]: JSON.parse(row.payload) })
    } catch {
      // An unreadable row is dropped; the next save rewrites or deletes it.
    }
  }
  return cache
}

function writeEntries(db: SyncDatabase, cache: GitHubCache, importedSidecar: string | null): void {
  const upsert = db.prepare(
    `INSERT INTO entries(kind, key, hash, payload) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, key) DO UPDATE SET hash = excluded.hash, payload = excluded.payload`
  )
  const remove = db.prepare('DELETE FROM entries WHERE kind = ? AND key = ?')
  db.exec('BEGIN IMMEDIATE')
  try {
    // Read the baseline under the write lock, so another writer's commit cannot leave it stale.
    const stored = new Map<string, string>()
    for (const row of db.prepare('SELECT kind, key, hash FROM entries').all()) {
      if (typeof row.kind === 'string' && typeof row.key === 'string') {
        stored.set(rowId(row.kind, row.key), String(row.hash))
      }
    }
    for (const kind of KINDS) {
      for (const [key, entry] of Object.entries(cache[kind] ?? {})) {
        const payload = JSON.stringify(entry)
        if (payload === undefined) {
          continue
        }
        const id = rowId(kind, key)
        const hash = sha256(payload)
        if (stored.get(id) !== hash) {
          upsert.run(kind, key, hash, payload)
        }
        stored.delete(id)
      }
    }
    for (const id of stored.keys()) {
      const [kind, key] = id.split('\u0000', 2)
      remove.run(kind, key)
    }
    if (importedSidecar !== null) {
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        IMPORTED_SIDECAR_KEY,
        importedSidecar
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
}

function rowId(kind: string, key: string): string {
  return `${kind}\u0000${key}`
}
