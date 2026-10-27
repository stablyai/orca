import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { readOpenCodeNativeChatTranscriptFull } from './transcript-opencode'
import type { AgentType } from '../../shared/native-chat-types'
import { InFlightPromiseDedupe, stableInFlightKey } from '../../shared/in-flight-promise-dedupe'
import { resolveSessionFilePath } from './session-file-resolver'
import { readNativeChatTranscript, type ReadTranscriptResult } from './transcript-reader'
import { wslGatedStat } from './wsl-transcript-fs-access'
import {
  isWslTranscriptFsRefusalMessage,
  WslTranscriptFsError,
  wslTranscriptFsRefusal
} from './wsl-transcript-fs-error'

// Share one unwindowed parse per resolved path across desktop and paired clients.
// Session IDs can resolve to different worktree files; connection keys would duplicate memory.

type CachedTranscript = {
  result: ReadTranscriptResult
  mtimeMs: number
  /** Disk bytes approximate parsed memory for eviction. */
  bytes: number
  readOrder: number
}

const cache = new Map<string, CachedTranscript>()
const inFlightReads = new InFlightPromiseDedupe<ReadTranscriptResult>()
let cacheEpoch = 0
let nextReadOrder = 0

const MAX_CACHE_ENTRIES = 50
// Count alone permits gigabytes of full transcripts; also cap bytes while retaining the active entry.
const MAX_CACHE_BYTES = 128 * 1024 * 1024
let maxCacheBytes = MAX_CACHE_BYTES

function setCached(key: string, value: CachedTranscript): void {
  cache.delete(key)
  cache.set(key, value)
  let totalBytes = 0
  for (const entry of cache.values()) {
    totalBytes += entry.bytes
  }
  // Keep the newest even over budget to avoid reparsing a single large active transcript on every read.
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
    const stats = await wslGatedStat(filePath, 'exact')
    return { mtimeMs: stats.mtimeMs, bytes: stats.size }
  } catch (err) {
    // Preserve gate refusal; falling through would spend another deadline on a full read.
    if (err instanceof WslTranscriptFsError) {
      throw err
    }
    return { mtimeMs: Number.NaN, bytes: 0 }
  }
}

/** Cache by mtime/size; callers apply their own windows to the canonical full parse. */
export async function readNativeChatTranscriptCached(
  agent: AgentType,
  sessionId: string,
  transcriptPath?: string
): Promise<ReadTranscriptResult> {
  if (resolveNativeChatTranscriptAgent(agent) === 'opencode') {
    return readOpenCodeNativeChatTranscriptFull(
      sessionId,
      {},
      undefined,
      agent === 'zcode' ? 'zcode' : undefined
    )
  }
  const epoch = cacheEpoch
  let filePath: string | null
  try {
    filePath = await resolveSessionFilePath(agent, sessionId, { transcriptPath })
  } catch (err) {
    // Unavailability is neither cached nor marked missing; the next call must resolve again.
    return { error: wslTranscriptFsRefusal(err).message }
  }
  if (!filePath) {
    // First flush may not have happened; never cache a missing transcript.
    return { error: `No transcript found for ${agent} session ${sessionId}`, notFound: true }
  }

  const key = cacheKey(agent, filePath)
  let cached = epoch === cacheEpoch ? cache.get(key) : undefined
  let mtimeMs: number
  let bytes: number
  try {
    ;({ mtimeMs, bytes } = await fileStat(filePath))
  } catch (err) {
    // Failed stat cannot prove the cached parse stale; keep complete content visible through a distro stall.
    cached = epoch === cacheEpoch ? (cache.get(key) ?? cached) : undefined
    if (cached) {
      setCached(key, cached)
      return cached.result
    }
    return { error: wslTranscriptFsRefusal(err).message }
  }
  cached = epoch === cacheEpoch ? cache.get(key) : undefined
  if (cached && Number.isFinite(mtimeMs) && cached.mtimeMs === mtimeMs && cached.bytes === bytes) {
    setCached(key, cached)
    return cached.result
  }

  if (!Number.isFinite(mtimeMs) || epoch !== cacheEpoch) {
    return readNativeChatTranscript(agent, sessionId, { filePath })
  }

  return inFlightReads.run(stableInFlightKey([key, mtimeMs, bytes, epoch]), async () => {
    const readOrder = ++nextReadOrder
    const result = await readNativeChatTranscript(agent, sessionId, { filePath })
    // Late parses must not overwrite a newer completed read or repopulate a cleared cache.
    if (
      epoch === cacheEpoch &&
      (cache.get(key)?.readOrder ?? 0) < readOrder &&
      !isRetryableReadError(result)
    ) {
      setCached(key, { result, mtimeMs, bytes, readOrder })
    }
    return result
  })
}

function isRetryableReadError(result: ReadTranscriptResult): boolean {
  return (
    'error' in result && (result.notFound === true || isWslTranscriptFsRefusalMessage(result.error))
  )
}

export function clearNativeChatTranscriptCache(): void {
  cacheEpoch += 1
  inFlightReads.clear()
  cache.clear()
}

export function setNativeChatTranscriptCacheMaxBytesForTests(bytes?: number): void {
  maxCacheBytes = bytes ?? MAX_CACHE_BYTES
}
