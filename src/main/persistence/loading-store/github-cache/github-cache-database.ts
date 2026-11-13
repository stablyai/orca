import { dirname, join } from 'node:path'
import type { PersistedState } from '../../../../shared/persisted-state-types'
import {
  KeyedJsonRowCache,
  parseKeyedJsonRows,
  type KeyedJsonRow
} from '../../../sqlite/row-cache/keyed-json-row-cache'
import { getGithubCacheFile } from '../user-data-path'

type GitHubCache = PersistedState['githubCache']
type GitHubCacheKind = keyof GitHubCache

/** Main-thread callers never wait out another writer's lock; they retry later instead. */
export const GITHUB_CACHE_ROUTINE_BUSY_TIMEOUT_MS = 25
/** Quit and explicit barriers may wait briefly so a transient lock does not drop the save. */
export const GITHUB_CACHE_BARRIER_BUSY_TIMEOUT_MS = 500

// 2: rows moved to the shared keyed row layout; a version-1 cache rebuilds empty once.
const GITHUB_CACHE_SCHEMA_VERSION = 2
const KINDS: readonly GitHubCacheKind[] = ['pr', 'issue']

export function getGithubCacheDatabaseFile(dataFile: string): string {
  return join(dirname(dataFile), 'orca-github-cache.db')
}

/**
 * Next-launch copy of the PR/issue caches, one row per entry, so a save rewrites only entries
 * whose content changed. Disposable: a corrupt or mismatched database rebuilds empty and the
 * next poll refills it. No handle outlives a call (profile moves, Windows).
 */
function githubCacheRows(dataFile: string): KeyedJsonRowCache {
  return new KeyedJsonRowCache(getGithubCacheDatabaseFile(dataFile), {
    schemaVersion: GITHUB_CACHE_SCHEMA_VERSION,
    busyTimeoutMs: GITHUB_CACHE_ROUTINE_BUSY_TIMEOUT_MS,
    holdConnection: false,
    legacyPath: getGithubCacheFile(dataFile)
  })
}

export type StoredGitHubCache = {
  /** What to hydrate, or null when nothing can be hydrated now. */
  cache: GitHubCache | null
  /** `cache` came from an older build's sidecar, so it must be saved as rows. */
  fromSidecar: boolean
  /** Receipt of an older build's sidecar to retire once rows that supersede it commit. */
  sidecarHash: string | null
  /** The rows or the sidecar could not be read: this session must not save over them. */
  unavailable: boolean
}

/**
 * Startup read. An older build's sidecar is newer than the rows unless the rows record having
 * imported exactly its bytes. While either cannot be read, nothing is hydrated and the caller
 * saves nothing this session, so neither the rows nor an unread sidecar are lost.
 */
export function readGitHubCacheDatabase(dataFile: string): StoredGitHubCache {
  const loaded = githubCacheRows(dataFile).load(parseGitHubCacheSidecar)
  if (loaded.kind === 'unavailable') {
    return { cache: null, fromSidecar: false, sidecarHash: null, unavailable: true }
  }
  if (loaded.kind === 'import') {
    return {
      cache: loaded.value,
      fromSidecar: true,
      sidecarHash: loaded.receipt,
      unavailable: false
    }
  }
  const cache: GitHubCache = { pr: {}, issue: {} }
  for (const { key: id, value } of parseKeyedJsonRows(loaded.rows)) {
    const separator = id.indexOf('\u0000')
    const kind = KINDS.find((candidate) => candidate === id.slice(0, separator))
    if (kind) {
      Object.assign(cache[kind], { [id.slice(separator + 1)]: value })
    }
  }
  const hasRows = Object.keys(cache.pr).length + Object.keys(cache.issue).length > 0
  return {
    cache: hasRows ? cache : null,
    fromSidecar: false,
    sidecarHash: null,
    unavailable: false
  }
}

/**
 * Save the cache, writing only rows whose content changed. `importedLegacyFileHash` names the
 * sidecar whose content `cache` already holds (imported or superseded): the commit records it,
 * then removes the sidecar if it is still that file. Throws on a failed commit, busy included.
 */
export function writeGitHubCacheDatabase(
  dataFile: string,
  cache: GitHubCache,
  options: { busyTimeoutMs: number; importedLegacyFileHash: string | null }
): void {
  githubCacheRows(dataFile).write(githubCacheRowsOf(cache), {
    busyTimeoutMs: options.busyTimeoutMs,
    importReceipt: options.importedLegacyFileHash ?? undefined
  })
}

function githubCacheRowsOf(cache: GitHubCache): KeyedJsonRow[] {
  const rows: KeyedJsonRow[] = []
  for (const kind of KINDS) {
    for (const [key, entry] of Object.entries(cache[kind] ?? {})) {
      const json = JSON.stringify(entry)
      if (json !== undefined) {
        rows.push({ key: `${kind}\u0000${key}`, json })
      }
    }
  }
  return rows
}

/** The shape check the sidecar reader always applied; unusable sidecars are rejected. */
function parseGitHubCacheSidecar(text: string): GitHubCache | null {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed) || !isRecord(parsed.pr) || !isRecord(parsed.issue)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same shape check the sidecar reader always applied; entries stay opaque cache payloads.
  return parsed as GitHubCache
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
