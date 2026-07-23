import type { AiVaultSession } from '../../shared/ai-vault-types'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import type { ResumableSessionParseState } from './session-scanner-types'

// Covers the 1,000 recent plus 2,000 in-scope result caps with refresh headroom.
export const AI_VAULT_PARSE_CACHE_MAX_ENTRIES = 4_096
export const AI_VAULT_PARSE_CACHE_KEY_MAX_UTF8_BYTES = 32 * 1024
export const AI_VAULT_PARSE_CACHE_VALUE_MAX_UTF8_BYTES = 256 * 1024
export const AI_VAULT_PARSE_CACHE_MAX_RETAINED_UTF8_BYTES = 32 * 1024 * 1024

export type SessionParseCacheEntry = {
  mtimeMs: number
  sizeBytes: number | null
  platform: NodeJS.Platform
  session: AiVaultSession | null
  resume: {
    state: ResumableSessionParseState
    // A trailing unterminated record must be reread after its writer completes it.
    byteOffset: number
  } | null
}

export type PersistedSessionParseCacheEntry = Omit<SessionParseCacheEntry, 'resume'>

type RetainedEntry = {
  entry: SessionParseCacheEntry
  retainedUtf8Bytes: number
}

const cache = new Map<string, RetainedEntry>()
let retainedUtf8Bytes = 0
let maxRetainedUtf8Bytes = AI_VAULT_PARSE_CACHE_MAX_RETAINED_UTF8_BYTES

export function getSessionParseCacheEntry(path: string): SessionParseCacheEntry | undefined {
  return cache.get(path)?.entry
}

export function resetSessionParseCacheRetentionForTests(): void {
  cache.clear()
  retainedUtf8Bytes = 0
  maxRetainedUtf8Bytes = AI_VAULT_PARSE_CACHE_MAX_RETAINED_UTF8_BYTES
}

export function setSessionParseCacheMaxRetainedBytesForTests(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Session parse cache byte limit must be a non-negative safe integer')
  }
  cache.clear()
  retainedUtf8Bytes = 0
  maxRetainedUtf8Bytes = maxBytes
}

export function inspectSessionParseCacheRetentionForTests(): {
  paths: string[]
  retainedUtf8Bytes: number
} {
  return { paths: [...cache.keys()], retainedUtf8Bytes }
}

export function snapshotSessionParseCacheForPersistence(): [
  string,
  PersistedSessionParseCacheEntry
][] {
  return [...cache].map(([path, retained]) => [path, persistedEntry(retained.entry)])
}

export function seedSessionParseCache(
  entries: Iterable<[string, PersistedSessionParseCacheEntry]>
): void {
  const tail = newestEntryTail(entries)
  const selected: [string, SessionParseCacheEntry, number][] = []
  const selectedPaths = new Set<string>()
  let availableEntries = AI_VAULT_PARSE_CACHE_MAX_ENTRIES - cache.size
  let availableBytes = maxRetainedUtf8Bytes - retainedUtf8Bytes

  for (let index = tail.length - 1; index >= 0 && availableEntries > 0; index -= 1) {
    const [path, persisted] = tail[index]
    // Live entries are fresher than disk, and the newest duplicate seed wins.
    if (cache.has(path) || selectedPaths.has(path)) {
      continue
    }
    selectedPaths.add(path)
    const entry: SessionParseCacheEntry = { ...persisted, resume: null }
    const bytes = retainedEntryUtf8Bytes(path, entry)
    if (bytes === null || bytes > availableBytes) {
      continue
    }
    selected.push([path, entry, bytes])
    availableEntries--
    availableBytes -= bytes
  }

  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const [path, entry, bytes] = selected[index]
    cache.set(path, { entry, retainedUtf8Bytes: bytes })
    retainedUtf8Bytes += bytes
  }
}

export function storeSessionParseCacheEntry(path: string, entry: SessionParseCacheEntry): void {
  deleteSessionParseCacheEntry(path)
  const bytes = retainedEntryUtf8Bytes(path, entry)
  if (bytes === null || bytes > maxRetainedUtf8Bytes) {
    return
  }

  while (
    cache.size >= AI_VAULT_PARSE_CACHE_MAX_ENTRIES ||
    retainedUtf8Bytes + bytes > maxRetainedUtf8Bytes
  ) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      return
    }
    deleteSessionParseCacheEntry(oldest)
  }

  cache.set(path, { entry, retainedUtf8Bytes: bytes })
  retainedUtf8Bytes += bytes
}

function retainedEntryUtf8Bytes(path: string, entry: SessionParseCacheEntry): number | null {
  const keyBytes = Buffer.byteLength(path, 'utf8')
  if (keyBytes > AI_VAULT_PARSE_CACHE_KEY_MAX_UTF8_BYTES) {
    return null
  }
  try {
    const persistedBytes = stringifyJsonWithinByteLimit(
      persistedEntry(entry),
      AI_VAULT_PARSE_CACHE_VALUE_MAX_UTF8_BYTES
    ).byteLength
    const resumeBytes = entry.resume?.state.retainedUtf8Bytes() ?? 0
    const valueBytes = persistedBytes + resumeBytes
    if (
      resumeBytes < 0 ||
      !Number.isSafeInteger(valueBytes) ||
      valueBytes > AI_VAULT_PARSE_CACHE_VALUE_MAX_UTF8_BYTES
    ) {
      return null
    }
    return keyBytes + valueBytes
  } catch {
    return null
  }
}

function persistedEntry(entry: SessionParseCacheEntry): PersistedSessionParseCacheEntry {
  return {
    mtimeMs: entry.mtimeMs,
    sizeBytes: entry.sizeBytes,
    platform: entry.platform,
    session: entry.session
  }
}

function deleteSessionParseCacheEntry(path: string): void {
  const retained = cache.get(path)
  if (!retained) {
    return
  }
  cache.delete(path)
  retainedUtf8Bytes -= retained.retainedUtf8Bytes
}

function newestEntryTail(
  entries: Iterable<[string, PersistedSessionParseCacheEntry]>
): [string, PersistedSessionParseCacheEntry][] {
  const ring = Array.from({ length: AI_VAULT_PARSE_CACHE_MAX_ENTRIES }) as [
    string,
    PersistedSessionParseCacheEntry
  ][]
  let count = 0
  for (const entry of entries) {
    ring[count % AI_VAULT_PARSE_CACHE_MAX_ENTRIES] = entry
    count++
  }
  const length = Math.min(count, AI_VAULT_PARSE_CACHE_MAX_ENTRIES)
  const start = count > length ? count % AI_VAULT_PARSE_CACHE_MAX_ENTRIES : 0
  return Array.from({ length }, (_, index) => ring[(start + index) % ring.length])
}
