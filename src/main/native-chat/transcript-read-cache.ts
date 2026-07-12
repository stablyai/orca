import { stat } from 'node:fs/promises'
import type { AgentType } from '../../shared/native-chat-types'
import { isCodexCompressedRolloutPath } from '../ai-vault/session-scanner-codex-paths'
import { resolveSessionFilePath } from './session-file-resolver'
import { readNativeChatTranscript, type ReadTranscriptResult } from './transcript-reader'
import type { TranscriptDecodeLimits } from './transcript-stream-lines'

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
// their file mtimes momentarily coincided (#7326). Desktop entries store a
// canonical unwindowed parse; paired clients use a separate fixed-size tail
// entry that is reused across requested windows.

type CachedTranscript = {
  result: ReadTranscriptResult
  /** mtime of the resolved file when cached; a newer mtime invalidates it. */
  mtimeMs: number
  /** Conservative weight for this entry's parsed memory footprint. */
  bytes: number
}

const cache = new Map<string, CachedTranscript>()

// Why: cap the cache so a long-lived process browsing many sessions can't grow
// it unbounded. Map preserves insertion order, so evicting the first key drops
// the oldest entry (a simple LRU once re-inserts bump recency; see setCached).
const MAX_CACHE_ENTRIES = 50
// Why: a heavy Claude/Codex coding session's JSONL is routinely tens of MB (tool
// results embed whole file contents, command output, and diffs). The count cap
// alone let 50 such entries retain multiple GB in the process serving desktop
// and paired clients. Bound total cache weight too; entries over budget are read
// successfully but not retained.
const MAX_CACHE_BYTES = 128 * 1024 * 1024
// Overridable only from tests so the byte-eviction path can be exercised without
// writing hundreds of MB of fixtures; production always uses MAX_CACHE_BYTES.
let maxCacheBytes = MAX_CACHE_BYTES

function setCached(key: string, value: CachedTranscript): void {
  // Re-insert moves the key to the most-recent position for LRU eviction.
  cache.delete(key)
  // Why: retaining one entry past the budget defeats the RSS guard entirely.
  // Oversized reads still succeed; they are simply re-read instead of cached.
  if (!Number.isFinite(value.bytes) || value.bytes > maxCacheBytes) {
    return
  }
  cache.set(key, value)
  let totalBytes = 0
  for (const entry of cache.values()) {
    totalBytes += entry.bytes
  }
  // Evict oldest until within both caps.
  while (cache.size > 0 && (cache.size > MAX_CACHE_ENTRIES || totalBytes > maxCacheBytes)) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    totalBytes -= cache.get(oldest)?.bytes ?? 0
    cache.delete(oldest)
  }
}

function cacheKey(
  agent: AgentType,
  filePath: string,
  limits: TranscriptDecodeLimits | undefined
): string {
  const mode = limits
    ? `${limits.maxDecodedBytes ?? ''}:${limits.maxLineBytes ?? ''}:${limits.maxMessages ?? ''}`
    : 'full'
  return `${agent}:${filePath}:${mode}`
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
 * Read a transcript for an agent + session, returning the policy-specific cached
 * parse on an mtime hit and re-reading when the file changed. Desktop callers
 * omit limits; paired clients cache one fixed-size tail for subsequent windows.
 */
export async function readNativeChatTranscriptCached(
  agent: AgentType,
  sessionId: string,
  /** Hook-reported authoritative transcript path, preferred over the id glob. */
  transcriptPath?: string,
  options: {
    requireTranscriptPathInAgentRoots?: boolean
    limits?: TranscriptDecodeLimits
  } = {}
): Promise<ReadTranscriptResult> {
  const filePath = await resolveSessionFilePath(agent, sessionId, {
    transcriptPath,
    requireTranscriptPathInAgentRoots: options.requireTranscriptPathInAgentRoots
  })
  if (!filePath) {
    // Not cached (see below): a not-yet-flushed transcript should be re-checked
    // on the next call, not pinned as a settled miss (#8401).
    return { error: `No transcript found for ${agent} session ${sessionId}`, notFound: true }
  }

  const key = cacheKey(agent, filePath, options.limits)
  const { mtimeMs, bytes: onDiskBytes } = await fileStat(filePath)
  const cached = cache.get(key)
  if (cached && Number.isFinite(mtimeMs) && cached.mtimeMs === mtimeMs) {
    // Bump recency so a frequently-read session survives eviction.
    setCached(key, cached)
    return cached.result
  }

  const result = await readNativeChatTranscript(agent, sessionId, {
    filePath,
    limits: options.limits
  })
  if (Number.isFinite(mtimeMs)) {
    // A compressed file's disk size says nothing about retained decoded data.
    // A bounded parse can safely use its decoded cap as an upper-bound weight;
    // an unbounded compressed parse is deliberately not cached.
    const cacheBytes = isCodexCompressedRolloutPath(filePath)
      ? (options.limits?.maxDecodedBytes ?? Number.POSITIVE_INFINITY)
      : onDiskBytes
    setCached(key, { result, mtimeMs, bytes: Math.max(onDiskBytes, cacheBytes) })
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
