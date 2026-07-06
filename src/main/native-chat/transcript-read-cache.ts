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

function cacheKey(agent: AgentType, filePath: string): string {
  return `${agent}:${filePath}`
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

  const key = cacheKey(agent, filePath)
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

/** Test-only: drop the transcript parse cache between runs. */
export function clearNativeChatTranscriptCache(): void {
  cache.clear()
}
