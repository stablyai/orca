import { stat } from 'node:fs/promises'
import type { AgentType } from '../../shared/native-chat-types'
import { resolveSessionFilePath } from './session-file-resolver'
import { readNativeChatTranscript, type ReadTranscriptResult } from './transcript-reader'

// Why: both the desktop IPC handler and the runtime RPC handler read the same
// host-filesystem transcript, so a single process-global cache keyed by
// agent:sessionId maximizes the hit rate across desktop + every paired
// web/mobile client. Keying by connection instead would defeat the multi-client
// case this feature targets and multiply memory by the connection count.
// The cache stores ONE canonical, unwindowed parse; windowing and per-surface
// truncation stay in the callers so the same parse is reused across all `limit`
// values and every client kind.

type CachedTranscript = {
  result: ReadTranscriptResult
  /** mtime of the resolved file when cached; a newer mtime invalidates it. */
  mtimeMs: number
}

const cache = new Map<string, CachedTranscript>()

// Why: cap the cache so a long-lived process browsing many sessions can't grow
// it unbounded. Map preserves insertion order, so evicting the first key drops
// the oldest entry (a simple LRU once re-inserts bump recency; see setCached).
// Entry-count cap is fine for v1; a byte-aware cap is the follow-up if profiling
// shows RSS pressure now that one process serves many remote clients.
const MAX_CACHE_ENTRIES = 50

function setCached(key: string, value: CachedTranscript): void {
  // Re-insert moves the key to the most-recent position for LRU eviction.
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    cache.delete(oldest)
  }
}

function cacheKey(agent: AgentType, sessionId: string): string {
  return `${agent}:${sessionId}`
}

async function fileMtimeMs(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).mtimeMs
  } catch {
    return Number.NaN
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
    return { error: `No transcript found for ${agent} session ${sessionId}` }
  }

  const key = cacheKey(agent, sessionId)
  const mtimeMs = await fileMtimeMs(filePath)
  const cached = cache.get(key)
  if (cached && Number.isFinite(mtimeMs) && cached.mtimeMs === mtimeMs) {
    // Bump recency so a frequently-read session survives eviction.
    setCached(key, cached)
    return cached.result
  }

  const result = await readNativeChatTranscript(agent, sessionId, { filePath })
  if (Number.isFinite(mtimeMs)) {
    setCached(key, { result, mtimeMs })
  }
  return result
}

/** Test-only: drop the per-session transcript cache between runs. */
export function clearNativeChatTranscriptCache(): void {
  cache.clear()
}
