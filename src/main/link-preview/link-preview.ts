import {
  linkPreviewSize,
  type LinkPreviewRequest,
  type LinkPreviewResult
} from '../../shared/link-preview'
import { fetchLinkPreviewResource } from './link-preview-page-fetch'
import { decodeHtmlBody, readLinkPreviewMetadata } from './link-preview-page-metadata'

const DEADLINE_MS = 5_000
// YouTube puts its og tags ~780 KB into the page.
const MAX_PAGE_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 1024 * 1024
const MAX_FAVICON_BYTES = 64 * 1024
const PAGE_TTL_MS = 10 * 60_000
const UNAVAILABLE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 300
// Preview images are kept as data URLs; bound their total, not just their count.
const MAX_CACHE_BYTES = 20 * 1024 * 1024
const PAGE_TYPES = new Set(['text/html', 'application/xhtml+xml'])
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
const FAVICON_TYPES = new Set([
  ...IMAGE_TYPES,
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml'
])
const UNAVAILABLE: LinkPreviewResult = { kind: 'unavailable' }

type CacheEntry = { promise: Promise<LinkPreviewResult>; expiresAt: number; bytes: number }
const cache = new Map<string, CacheEntry>()
let cacheBytes = 0

function removeCacheEntry(key: string): void {
  cacheBytes -= cache.get(key)?.bytes ?? 0
  cache.delete(key)
}

function evictOldest(keep: string): void {
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined || oldest === keep) {
      return
    }
    removeCacheEntry(oldest)
  }
}

/** Never throws; blocked, failed and title-less pages are all `unavailable`. */
export function getLinkPreview(request: LinkPreviewRequest): Promise<LinkPreviewResult> {
  const key = cacheKey(request.url)
  if (!key) {
    return Promise.resolve(UNAVAILABLE)
  }
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.promise
  }
  removeCacheEntry(key)
  const entry: CacheEntry = {
    promise: loadLinkPreview(key)
      .catch(() => UNAVAILABLE)
      .then((result) => {
        entry.expiresAt = Date.now() + (result.kind === 'page' ? PAGE_TTL_MS : UNAVAILABLE_TTL_MS)
        if (result.kind === 'page' && cache.get(key) === entry) {
          entry.bytes = linkPreviewSize(result.preview)
          cacheBytes += entry.bytes
          // Re-insert as newest so the budget evicts older previews, not this one.
          cache.delete(key)
          cache.set(key, entry)
          evictOldest(key)
        }
        return result
      }),
    expiresAt: Number.POSITIVE_INFINITY,
    bytes: 0
  }
  cache.set(key, entry)
  evictOldest(key)
  return entry.promise
}

function cacheKey(raw: string): string | null {
  try {
    const url = new URL(raw)
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

async function loadLinkPreview(url: string): Promise<LinkPreviewResult> {
  const signal = AbortSignal.timeout(DEADLINE_MS)
  const page = await fetchLinkPreviewResource(url, {
    kind: 'page',
    mimeTypes: PAGE_TYPES,
    maxBytes: MAX_PAGE_BYTES,
    signal
  })
  if (!page) {
    return UNAVAILABLE
  }
  const metadata = readLinkPreviewMetadata(decodeHtmlBody(page.body, page.contentType), page.url)
  if (!metadata.title && !metadata.description) {
    return UNAVAILABLE
  }
  const [imageDataUrl, faviconDataUrl] = await Promise.all([
    metadata.imageUrl
      ? fetchImageDataUrl(metadata.imageUrl, IMAGE_TYPES, MAX_IMAGE_BYTES, signal)
      : null,
    fetchFaviconDataUrl(metadata.iconHref, page.url, signal)
  ])
  return {
    kind: 'page',
    preview: {
      url: page.url.href,
      title: metadata.title,
      description: metadata.description,
      siteName: metadata.siteName,
      imageDataUrl,
      faviconDataUrl
    }
  }
}

function fetchFaviconDataUrl(
  href: string,
  pageUrl: URL,
  signal: AbortSignal
): Promise<string | null> {
  const inline = /^data:([^;,]+)[;,]/i.exec(href)
  if (inline) {
    const allowed =
      FAVICON_TYPES.has(inline[1].toLowerCase()) && href.length <= MAX_FAVICON_BYTES * 2
    return Promise.resolve(allowed ? href : null)
  }
  let iconUrl: string
  try {
    iconUrl = new URL(href, pageUrl).href
  } catch {
    return Promise.resolve(null)
  }
  return fetchImageDataUrl(iconUrl, FAVICON_TYPES, MAX_FAVICON_BYTES, signal)
}

async function fetchImageDataUrl(
  url: string,
  mimeTypes: ReadonlySet<string>,
  maxBytes: number,
  signal: AbortSignal
): Promise<string | null> {
  const image = await fetchLinkPreviewResource(url, { kind: 'image', mimeTypes, maxBytes, signal })
  return image && image.body.length > 0
    ? `data:${image.mimeType};base64,${image.body.toString('base64')}`
    : null
}
