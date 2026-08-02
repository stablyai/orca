// Why: description and comments fetch attachments independently; comments also
// refetch after every post. Cache finished data URLs in main so the second path
// does not re-download or re-base64 the same attachment bytes.

const CACHE_TTL_MS = 30 * 60_000
const MAX_CACHE_ENTRIES = 96
const MAX_CACHE_BYTES = 24 * 1024 * 1024

type CacheEntry = {
  dataUrl: string
  byteSize: number
  storedAt: number
}

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<string | null>>()
// Why: mid-flight downloads must not repopulate cache after disconnect/clearToken.
// Why ONE ticker across both scopes: summing separate counters lets distinct clear
// states collide, passing the guard and re-inserting credentialed bytes.
let epochTicker = 0
let globalEpoch = 0
const siteEpoch = new Map<string, number>()

function cacheKey(siteId: string, attachmentId: string): string {
  return `${siteId}::${attachmentId}`
}

function nextEpoch(): number {
  epochTicker += 1
  return epochTicker
}

function currentEpoch(siteId: string): number {
  return Math.max(globalEpoch, siteEpoch.get(siteId) ?? 0)
}

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of cache) {
    if (now - entry.storedAt >= CACHE_TTL_MS) {
      cache.delete(key)
    }
  }
}

function totalCachedBytes(): number {
  let total = 0
  for (const entry of cache.values()) {
    total += entry.byteSize
  }
  return total
}

function evictUntilWithinBounds(): void {
  while (cache.size > MAX_CACHE_ENTRIES || totalCachedBytes() > MAX_CACHE_BYTES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    cache.delete(oldestKey)
  }
}

export function getCachedAttachmentDataUrl(siteId: string, attachmentId: string): string | null {
  pruneExpired()
  const key = cacheKey(siteId, attachmentId)
  const entry = cache.get(key)
  if (!entry) {
    return null
  }
  if (Date.now() - entry.storedAt >= CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  // Why: delete-then-set refreshes insertion order for LRU-style eviction.
  cache.delete(key)
  cache.set(key, entry)
  return entry.dataUrl
}

export function setCachedAttachmentDataUrl(args: {
  siteId: string
  attachmentId: string
  dataUrl: string
  byteSize: number
}): void {
  pruneExpired()
  const key = cacheKey(args.siteId, args.attachmentId)
  const entry: CacheEntry = {
    dataUrl: args.dataUrl,
    byteSize: args.byteSize,
    storedAt: Date.now()
  }
  cache.delete(key)
  cache.set(key, entry)
  evictUntilWithinBounds()
}

/**
 * Singleflight loader: concurrent cold misses for the same attachment share one
 * download. Failed loads are not cached so a later retry can succeed.
 */
export async function loadAttachmentDataUrlWithCache(args: {
  siteId: string
  attachmentId: string
  load: () => Promise<{ dataUrl: string; byteSize: number } | null>
}): Promise<string | null> {
  const cached = getCachedAttachmentDataUrl(args.siteId, args.attachmentId)
  if (cached) {
    return cached
  }

  const key = cacheKey(args.siteId, args.attachmentId)
  const existing = inFlight.get(key)
  if (existing) {
    return existing
  }

  const epochAtStart = currentEpoch(args.siteId)
  const promise = (async (): Promise<string | null> => {
    try {
      const loaded = await args.load()
      if (!loaded) {
        return null
      }
      // Why: return bytes to the waiter but skip cache if site was cleared mid-flight.
      if (currentEpoch(args.siteId) === epochAtStart) {
        setCachedAttachmentDataUrl({
          siteId: args.siteId,
          attachmentId: args.attachmentId,
          dataUrl: loaded.dataUrl,
          byteSize: loaded.byteSize
        })
      }
      return loaded.dataUrl
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, promise)
  return promise
}

export function clearAttachmentImagesForSite(siteId?: string): void {
  if (siteId == null || siteId === '') {
    cache.clear()
    inFlight.clear()
    globalEpoch = nextEpoch()
    siteEpoch.clear()
    return
  }
  siteEpoch.set(siteId, nextEpoch())
  const prefix = `${siteId}::`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) {
      inFlight.delete(key)
    }
  }
}

/** @internal — test-only */
export function _resetAttachmentImageCache(): void {
  cache.clear()
  inFlight.clear()
  epochTicker = 0
  globalEpoch = 0
  siteEpoch.clear()
}

/** @internal — test-only */
export function _getAttachmentImageCacheSize(): number {
  return cache.size
}
