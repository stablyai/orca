// Description, comments, and lazy image reads share one bounded cache.

import { MAX_TIMER_DELAY_MS } from '../../../shared/timer-delay'

const CACHE_TTL_MS = 30 * 60_000
const MAX_CACHE_ENTRIES = 96
const MAX_CACHE_BYTES = 24 * 1024 * 1024

export type AttachmentImageBytes = { data: Uint8Array<ArrayBuffer>; mimeType: string }
type ImageValue = string | AttachmentImageBytes

type CacheEntry = {
  image: ImageValue
  byteSize: number
  storedAt: number
}

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<
  string,
  { promise: Promise<ImageValue | null>; signal?: AbortSignal; generation: symbol }
>()
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let scheduledExpiryAt = Infinity
// One ticker prevents global/site clears from colliding and letting stale credentialed bytes repopulate the cache.
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

export function attachmentImagesEpoch(siteId: string): number {
  return Math.max(globalEpoch, siteEpoch.get(siteId) ?? 0)
}

function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
  scheduledExpiryAt = Infinity
}

function scheduleAttachmentExpiry(): void {
  let nextExpiryAt = Infinity
  for (const entry of cache.values()) {
    nextExpiryAt = Math.min(nextExpiryAt, entry.storedAt + CACHE_TTL_MS)
  }
  if (nextExpiryAt === Infinity) {
    clearExpiryTimer()
    return
  }
  if (expiryTimer !== null && scheduledExpiryAt <= nextExpiryAt) {
    return
  }
  clearExpiryTimer()
  scheduledExpiryAt = nextExpiryAt
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null
      scheduledExpiryAt = Infinity
      pruneExpired()
      scheduleAttachmentExpiry()
    },
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextExpiryAt - Date.now()))
  )
  expiryTimer.unref()
}

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of cache) {
    if (now - entry.storedAt >= CACHE_TTL_MS) {
      cache.delete(key)
    }
  }
  if (cache.size === 0) {
    clearExpiryTimer()
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

function getCachedImage(siteId: string, attachmentId: string): ImageValue | null {
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
  // Refresh insertion order for LRU-style eviction.
  cache.delete(key)
  cache.set(key, entry)
  return entry.image
}

function setCachedImage(args: {
  siteId: string
  attachmentId: string
  image: ImageValue
  byteSize: number
}): void {
  pruneExpired()
  const key = cacheKey(args.siteId, args.attachmentId)
  const entry: CacheEntry = {
    image: args.image,
    byteSize: args.byteSize,
    storedAt: Date.now()
  }
  cache.delete(key)
  cache.set(key, entry)
  evictUntilWithinBounds()
  scheduleAttachmentExpiry()
}

/** Share cold downloads within a cancellation domain; failed loads remain retryable. */
async function loadImageWithCache(args: {
  siteId: string
  attachmentId: string
  load: () => Promise<{ image: ImageValue; byteSize: number } | null>
  signal?: AbortSignal
}): Promise<ImageValue | null> {
  const cached = getCachedImage(args.siteId, args.attachmentId)
  if (cached) {
    return cached
  }

  // Legacy waiters must not inherit a cancellable reader's download.
  const key = `${cacheKey(args.siteId, args.attachmentId)}::${args.signal ? 'cancellable' : 'legacy'}`
  const existing = inFlight.get(key)
  if (existing && !existing.signal?.aborted) {
    return existing.promise
  }

  const epochAtStart = attachmentImagesEpoch(args.siteId)
  const generation = Symbol()
  const promise = (async (): Promise<ImageValue | null> => {
    try {
      const loaded = await args.load()
      if (!loaded) {
        return null
      }
      if (!args.signal?.aborted && attachmentImagesEpoch(args.siteId) === epochAtStart) {
        setCachedImage({
          siteId: args.siteId,
          attachmentId: args.attachmentId,
          image: loaded.image,
          byteSize: loaded.byteSize
        })
      }
      return loaded.image
    } finally {
      // A cleared generation no longer owns the current download's singleflight slot.
      if (inFlight.get(key)?.generation === generation) {
        inFlight.delete(key)
      }
    }
  })()

  inFlight.set(key, { promise, signal: args.signal, generation })
  return promise
}

function imageDataUrl(image: ImageValue): string {
  return typeof image === 'string'
    ? image
    : `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`
}

function imageBytes(image: ImageValue): AttachmentImageBytes | null {
  if (typeof image !== 'string') {
    return image
  }
  const match = /^data:(image\/[^;]+);base64,(.*)$/s.exec(image)
  if (!match?.[1] || match[2] === undefined) {
    return null
  }
  return { data: Uint8Array.from(Buffer.from(match[2], 'base64')), mimeType: match[1] }
}

export function getCachedAttachmentBytes(
  siteId: string,
  attachmentId: string
): AttachmentImageBytes | null {
  const image = getCachedImage(siteId, attachmentId)
  return image === null ? null : imageBytes(image)
}

export function getCachedAttachmentDataUrl(siteId: string, attachmentId: string): string | null {
  const image = getCachedImage(siteId, attachmentId)
  return image === null ? null : imageDataUrl(image)
}

export function setCachedAttachmentDataUrl(args: {
  siteId: string
  attachmentId: string
  dataUrl: string
  byteSize: number
}): void {
  setCachedImage({ ...args, image: args.dataUrl })
}

export async function loadAttachmentDataUrlWithCache(args: {
  siteId: string
  attachmentId: string
  load: () => Promise<{ dataUrl: string; byteSize: number } | null>
}): Promise<string | null> {
  const image = await loadImageWithCache({
    ...args,
    load: async () => {
      const loaded = await args.load()
      return loaded && { image: loaded.dataUrl, byteSize: loaded.byteSize }
    }
  })
  return image === null ? null : imageDataUrl(image)
}

export async function loadAttachmentBytesWithCache(args: {
  siteId: string
  attachmentId: string
  load: () => Promise<AttachmentImageBytes | null>
  signal?: AbortSignal
}): Promise<AttachmentImageBytes | null> {
  const image = await loadImageWithCache({
    ...args,
    load: async () => {
      const loaded = await args.load()
      return loaded && { image: loaded, byteSize: loaded.data.byteLength }
    }
  })
  return image === null ? null : imageBytes(image)
}

export function clearAttachmentImagesForSite(siteId?: string): void {
  if (siteId == null || siteId === '') {
    cache.clear()
    clearExpiryTimer()
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
  if (cache.size === 0) {
    clearExpiryTimer()
  }
}

/** @internal — test-only */
export function _resetAttachmentImageCache(): void {
  clearExpiryTimer()
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
