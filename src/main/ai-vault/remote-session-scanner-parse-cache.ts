import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileWithMtime } from './session-scanner-types'

// Sized past the remote recency cap (1000) plus the in-scope parse cap (2000)
// so a full steady-state result set stays resident between rescans; matches
// the local session-scanner-parse-cache bound.
export const REMOTE_PARSE_CACHE_MAX_ENTRIES_PER_HOST = 4096

type RemoteSessionParseCacheEntry = {
  mtimeMs: number
  sizeBytes: number | null
  session: AiVaultSession | null
}

type RemoteHostParseCache = {
  // Opaque connect-time machine identity supplied by the scan. A target id
  // can be repointed at a different machine (ssh:updateTarget, ssh-config
  // import, runtime reprovision) without being removed, so entries are only
  // valid while the scan talks to the machine they were read from.
  connectionIdentity: string | null
  entries: Map<string, RemoteSessionParseCacheEntry>
}

export type RemoteSessionParseCacheHit = {
  session: AiVaultSession | null
}

// Keyed by execution host so identical remote paths on different hosts can
// never serve each other's sessions. Reconnects to the same machine keep
// entries (paths and mtimes stay valid); an identity change resets the host's
// entries and target removal evicts via evictRemoteSessionParseCache.
const cacheByHost = new Map<ExecutionHostId, RemoteHostParseCache>()

/**
 * Return the parse result cached for this remote file when the host's
 * connection identity matches and the (mtime, size) stat is unchanged,
 * refreshing its LRU recency. A hit means the rescan skips the SSH body
 * transfer and re-parse entirely; `null` means read + parse.
 */
export function readCachedRemoteSessionParse(
  executionHostId: ExecutionHostId,
  connectionIdentity: string | null,
  file: FileWithMtime
): RemoteSessionParseCacheHit | null {
  const hostCache = cacheByHost.get(executionHostId)
  if (!hostCache || hostCache.connectionIdentity !== connectionIdentity) {
    return null
  }
  const entry = hostCache.entries.get(file.path)
  if (!entry) {
    return null
  }
  const unchanged =
    entry.mtimeMs === file.mtimeMs &&
    (entry.sizeBytes === null || file.sizeBytes === undefined || entry.sizeBytes === file.sizeBytes)
  if (!unchanged) {
    return null
  }
  hostCache.entries.delete(file.path)
  hostCache.entries.set(file.path, entry)
  return { session: entry.session }
}

export function storeRemoteSessionParse(
  executionHostId: ExecutionHostId,
  connectionIdentity: string | null,
  file: FileWithMtime,
  session: AiVaultSession | null
): void {
  let hostCache = cacheByHost.get(executionHostId)
  if (!hostCache || hostCache.connectionIdentity !== connectionIdentity) {
    // A different machine now answers for this host id: entries read from the
    // previous machine must never be served again, so drop them wholesale.
    hostCache = { connectionIdentity, entries: new Map() }
    cacheByHost.set(executionHostId, hostCache)
  }
  hostCache.entries.delete(file.path)
  hostCache.entries.set(file.path, {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    session
  })
  if (hostCache.entries.size > REMOTE_PARSE_CACHE_MAX_ENTRIES_PER_HOST) {
    const oldest = hostCache.entries.keys().next()
    if (!oldest.done) {
      hostCache.entries.delete(oldest.value)
    }
  }
}

export function evictRemoteSessionParseCache(executionHostId: ExecutionHostId): void {
  cacheByHost.delete(executionHostId)
}

export function resetRemoteSessionParseCacheForTests(): void {
  cacheByHost.clear()
}
