import { stat } from 'node:fs/promises'
import type { AgentType } from '../../shared/native-chat-types'
import { resolveSessionFilePath } from './session-file-resolver'
import { readNativeChatTranscript, type ReadTranscriptResult } from './transcript-reader'

// Why: both the desktop IPC handler and the runtime RPC handler read the same
// host-filesystem transcript, so a single process-global cache keyed by the
// RESOLVED transcript file path maximizes the hit rate across desktop + every
// paired web/mobile client (all clients of one session resolve the same path
// against this runtime's home). Keying by connection instead would defeat the
// multi-client case this feature targets and multiply memory by the connection
// count. The key is the resolved file path, NOT `agent:sessionId`: two panes can
// share one sessionId yet resolve to DIFFERENT files (the same session resumed
// into a second worktree, which writes a new transcript file), and a
// sessionId-only key let one worktree's cached parse be served to another when
// their file mtimes momentarily coincided (#7326). The cache stores ONE
// canonical, unwindowed parse; windowing and per-surface truncation stay in the
// callers so the same parse is reused across all `limit` values and every client kind.

type CachedTranscript = {
  result: ReadTranscriptResult
  /** mtime of the resolved file when cached; a newer mtime invalidates it. */
  mtimeMs: number
  /** On-disk byte size of the resolved file — a cheap, monotonic proxy for this
   *  entry's parsed memory footprint, used to bound the cache by total bytes. */
  bytes: number
}

const cache = new Map<string, CachedTranscript>()

// Why: cap the cache so a long-lived process browsing many sessions can't grow
// it unbounded. Map preserves insertion order, so evicting the first key drops
// the oldest entry (a simple LRU once re-inserts bump recency; see setCached).
const MAX_CACHE_ENTRIES = 50
// Why: a heavy Claude/Codex coding session's JSONL is routinely tens of MB (tool
// results embed whole file contents, command output, and diffs), and each cached
// entry is the full unwindowed parse. The count cap alone let 50 such entries
// retain multiple GB in the one process that now serves desktop + every paired
// web/mobile client. Bound total cached file bytes too; we always keep the most-
// recent entry (see setCached) so an active transcript is never re-parsed on
// every read, which caps the regression to extra re-parses only past this budget.
const MAX_CACHE_BYTES = 128 * 1024 * 1024
// Overridable only from tests so the byte-eviction path can be exercised without
// writing hundreds of MB of fixtures; production always uses MAX_CACHE_BYTES.
let maxCacheBytes = MAX_CACHE_BYTES

function setCached(key: string, value: CachedTranscript): void {
  // Re-insert moves the key to the most-recent position for LRU eviction.
  cache.delete(key)
  cache.set(key, value)
  let totalBytes = 0
  for (const entry of cache.values()) {
    totalBytes += entry.bytes
  }
  // Evict oldest until within BOTH caps, but never drop the most-recent entry
  // (cache.size > 1): a single active transcript larger than the whole budget
  // must stay cached or every read would re-parse the full file.
  while (cache.size > 1 && (cache.size > MAX_CACHE_ENTRIES || totalBytes > maxCacheBytes)) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    totalBytes -= cache.get(oldest)?.bytes ?? 0
    cache.delete(oldest)
  }
}

function cacheKey(agent: AgentType, filePath: string): string {
  return `${agent}:${filePath}`
}

async function fileStat(filePath: string): Promise<{ mtimeMs: number; bytes: number }> {
  try {
    const stats = await stat(filePath)
    return { mtimeMs: stats.mtimeMs, bytes: stats.size }
  } catch {
    return { mtimeMs: Number.NaN, bytes: 0 }
  }
}

/**
 * Read the full transcript for an agent + session, returning the cached parse on
 * an mtime hit and re-reading (and re-caching) when the file changed. Returns the
 * canonical, unwindowed result; callers apply their own windowing/truncation.
 */
export async function readNativeChatTranscriptCached(
  agent: AgentType,
  sessionId: string,
  /** Hook-reported authoritative transcript path, preferred over the id glob. */
  transcriptPath?: string
): Promise<ReadTranscriptResult> {
  const filePath = await resolveSessionFilePath(agent, sessionId, { transcriptPath })
  if (!filePath) {
    // Not cached (see below): a not-yet-flushed transcript should be re-checked
    // on the next call, not pinned as a settled miss (#8401).
    return { error: `No transcript found for ${agent} session ${sessionId}`, notFound: true }
  }

  const key = cacheKey(agent, filePath)
  const { mtimeMs, bytes } = await fileStat(filePath)
  const cached = cache.get(key)
  if (cached && Number.isFinite(mtimeMs) && cached.mtimeMs === mtimeMs) {
    // Bump recency so a frequently-read session survives eviction.
    setCached(key, cached)
    return cached.result
  }

  const result = await readNativeChatTranscript(agent, sessionId, { filePath })
  if (Number.isFinite(mtimeMs)) {
    setCached(key, { result, mtimeMs, bytes })
  }
  return result
}

/** Test-only: drop the transcript parse cache between runs. */
export function clearNativeChatTranscriptCache(): void {
  cache.clear()
}

/** Test-only: override the byte budget (pass no arg to restore the default). */
export function setNativeChatTranscriptCacheMaxBytesForTests(bytes?: number): void {
  maxCacheBytes = bytes ?? MAX_CACHE_BYTES
}
