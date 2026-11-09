import { existsSync } from 'node:fs'
import type { PersistedState } from '../../../shared/persisted-state-types'
import SyncDatabase from '../../sqlite/sync-database'
import {
  isUnusableDatabaseError,
  removeVersionedCacheDatabase
} from '../../sqlite/versioned-cache-database'
import {
  GITHUB_CACHE_ROUTINE_BUSY_TIMEOUT_MS,
  GITHUB_CACHE_SCHEMA_VERSION,
  getGithubCacheDatabaseFile,
  IMPORTED_SIDECAR_KEY,
  readGitHubCacheEntries
} from './github-cache-database'
import { readGitHubCacheSidecar } from './github-cache-sidecar'

type GitHubCache = PersistedState['githubCache']

export type StoredGitHubCache = {
  /** What to hydrate, or null when nothing can be hydrated now. */
  cache: GitHubCache | null
  /** `cache` came from an older build's sidecar, so it must be saved as rows. */
  fromSidecar: boolean
  /** Fingerprint of a sidecar to retire once rows that supersede it commit. */
  sidecarHash: string | null
}

type SavedRows =
  | { kind: 'rows'; cache: GitHubCache; importedSidecar: string | null }
  | { kind: 'empty' }
  /** Rows exist but cannot be read now, usually another connection's lock. */
  | { kind: 'unavailable' }

/**
 * Startup read. An older build's sidecar is newer than the rows unless the rows record having
 * imported exactly its bytes; while the rows cannot be read, that is unknown, so the sidecar is
 * neither hydrated nor allowed to replace rows (the first commit supersedes it instead).
 */
export function readGitHubCacheDatabase(dataFile: string): StoredGitHubCache {
  const sidecar = readGitHubCacheSidecar(dataFile)
  const saved = readSavedRows(getGithubCacheDatabaseFile(dataFile))
  if (sidecar && saved.kind !== 'unavailable') {
    if (saved.kind === 'empty' || saved.importedSidecar !== sidecar.hash) {
      return { cache: sidecar.cache, fromSidecar: true, sidecarHash: sidecar.hash }
    }
  }
  const rows = saved.kind === 'rows' ? saved.cache : null
  const hasRows = rows !== null && Object.keys(rows.pr).length + Object.keys(rows.issue).length > 0
  return { cache: hasRows ? rows : null, fromSidecar: false, sidecarHash: sidecar?.hash ?? null }
}

/** One read-only snapshot: no write lock, so another writer cannot block or fail startup. */
function readSavedRows(path: string): SavedRows {
  // One-shot: the synchronous profile load reads this once at startup.
  if (!existsSync(path)) {
    return { kind: 'empty' }
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(path, { readonly: true, fileMustExist: true })
    db.pragma(`busy_timeout = ${GITHUB_CACHE_ROUTINE_BUSY_TIMEOUT_MS}`)
    db.exec('BEGIN')
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'entries')"
        )
        .all()
      const version =
        tables.length === 2
          ? db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
          : undefined
      if (version?.value !== String(GITHUB_CACHE_SCHEMA_VERSION)) {
        // Another schema rebuilds empty at the next save, as a mismatched cache always has.
        return { kind: 'empty' }
      }
      const marker = db.prepare('SELECT value FROM meta WHERE key = ?').get(IMPORTED_SIDECAR_KEY)
      return {
        kind: 'rows',
        cache: readGitHubCacheEntries(db),
        importedSidecar: typeof marker?.value === 'string' ? marker.value : null
      }
    } finally {
      if (db.isTransaction) {
        db.exec('COMMIT')
      }
    }
  } catch (error) {
    if (!isUnusableDatabaseError(error)) {
      return { kind: 'unavailable' }
    }
    db?.close()
    db = null
    // Damaged rows hold nothing recoverable; the next save rebuilds the cache.
    removeVersionedCacheDatabase(path, 'fail-fast')
    return { kind: 'empty' }
  } finally {
    db?.close()
  }
}
