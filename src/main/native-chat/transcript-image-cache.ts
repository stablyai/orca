import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type {
  NativeChatBlock,
  NativeChatImageRefBlock,
  NativeChatMessage
} from '../../shared/native-chat-types'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import type { RuntimeFilePreviewResult } from '../../shared/runtime-file-contracts'
import { isKnownRasterImageMimeType } from '../../shared/raster-image-preview-limits'
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  tightenPathMode
} from '../daemon/daemon-private-file-modes'

// Per-image persist cap. Screenshots are 100KB–3MB in practice; 8 MiB bounds a
// runaway capture without touching real ones. Maintainer-adjustable (#23246).
export const NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES = 8 * 1024 * 1024
const CACHE_DIR_NAME = 'native-chat-images'
const CACHE_FILE_NAME = /^[0-9a-f]{64}\.(png|jpg|gif|webp|bmp|ico)$/
const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.split('/', 2)[1] ?? '') {
    case 'gif':
      return 'gif'
    case 'webp':
      return 'webp'
    case 'jpeg':
    case 'jpg':
    case 'pjpeg':
      return 'jpg'
    case 'ico':
    case 'vnd.microsoft.icon':
    case 'x-icon':
      return 'ico'
    case 'bmp':
    case 'x-bmp':
    case 'x-ms-bmp':
      return 'bmp'
    case 'apng':
      return 'png'
    default:
      return 'png'
  }
}

function parseInlineImage(url: string): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(url.trim())
  if (!match) {
    return null
  }
  const mimeType = match[1].split(';', 1)[0].trim().toLowerCase()
  if (!isKnownRasterImageMimeType(mimeType)) {
    return null
  }
  const payload = match[2].replace(/\s/g, '')
  if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    return null
  }
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length === 0 || bytes.length > NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES) {
    return null
  }
  return { mimeType, bytes }
}

let cacheDirOverride: string | undefined

/** Test-only: redirect the image cache (pass no arg to restore userData). */
export function setNativeChatImageCacheDirForTests(dir?: string): void {
  cacheDirOverride = dir
}

function defaultCacheDir(): string {
  return cacheDirOverride ?? join(getAppEnvironment().getPath('userData'), CACHE_DIR_NAME)
}

function isInlineImageRef(block: NativeChatBlock): block is NativeChatImageRefBlock {
  return block.type === 'image-ref' && /^\s*data:/i.test(block.url ?? '')
}

// Entries are derived from transcripts, so an evicted one is simply rewritten on the next read.
export const NATIVE_CHAT_IMAGE_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const NATIVE_CHAT_IMAGE_CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
// Serving an entry refreshes its mtime at most this often, which is what keeps it out of pruning.
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000
const lastPrunedAt = new Map<string, number>()

/** Drop entries (and orphaned temp files) untouched for the retention window. */
export async function pruneNativeChatImageCache(cacheDir: string, now = Date.now()): Promise<void> {
  for (const name of await readdir(cacheDir)) {
    if (!CACHE_FILE_NAME.test(name) && !name.endsWith('.tmp')) {
      continue
    }
    await new Promise((resolveYield) => setImmediate(resolveYield))
    const filePath = join(cacheDir, name)
    try {
      // Stat and remove in one tick: hydration touches an entry before serving it, so it
      // cannot slip between this check and the removal.
      if (now - statSync(filePath).mtimeMs > NATIVE_CHAT_IMAGE_CACHE_RETENTION_MS) {
        rmSync(filePath, { force: true })
      }
    } catch {
      // Raced with another reader's write or removal; the next run retries.
    }
  }
}

/** Starts a prune when this dir has not had one within the interval; returns it, or null. */
export function pruneNativeChatImageCacheIfDue(
  cacheDir: string,
  now = Date.now()
): Promise<void> | null {
  const last = lastPrunedAt.get(cacheDir)
  if (last !== undefined && now - last < NATIVE_CHAT_IMAGE_CACHE_PRUNE_INTERVAL_MS) {
    return null
  }
  lastPrunedAt.set(cacheDir, now)
  return pruneNativeChatImageCache(cacheDir, now).catch(() => {})
}

/**
 * Persist inline (data:) image bytes to the host image cache and rewrite the
 * refs to cache paths. Content-hash naming makes writes idempotent across
 * re-reads; private modes apply because screenshots are the user's pixels.
 * Fail-open: anything unparseable, oversized, or unwritable keeps its inline
 * URL, which desktop still renders (mobile shows its placeholder instead).
 */
export function hydrateNativeChatImageRefs(
  messages: readonly NativeChatMessage[],
  options: { cacheDir?: string } = {}
): NativeChatMessage[] {
  if (!messages.some((message) => message.blocks.some(isInlineImageRef))) {
    return [...messages]
  }
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  try {
    ensurePrivateDir(cacheDir)
  } catch {
    // An unwritable cache must not take the transcript down; the refs stay inline.
    return [...messages]
  }
  void pruneNativeChatImageCacheIfDue(cacheDir)
  return messages.map((message) => {
    if (!message.blocks.some(isInlineImageRef)) {
      return message
    }
    return {
      ...message,
      blocks: message.blocks.map((block, index) =>
        hydrateBlock(block, cacheDir, `${cacheDir}\0${message.id}\0${index}`)
      )
    }
  })
}

// Why: every snapshot, replacement and append re-reads the same screenshots; remembering
// where a transcript block already landed skips re-decoding and re-hashing megabytes each time.
const MAX_HYDRATED_REFS = 256
const hydratedRefPaths = new Map<string, { path: string; touchedAt: number }>()

function rememberHydratedRef(key: string, filePath: string, touchedAt: number): void {
  hydratedRefPaths.delete(key)
  hydratedRefPaths.set(key, { path: filePath, touchedAt })
  if (hydratedRefPaths.size > MAX_HYDRATED_REFS) {
    const oldest = hydratedRefPaths.keys().next().value
    if (oldest !== undefined) {
      hydratedRefPaths.delete(oldest)
    }
  }
}

function touchCacheEntry(filePath: string, now: number): number {
  const seconds = now / 1000
  try {
    utimesSync(filePath, seconds, seconds)
  } catch {
    // Best effort: an untouched entry is only pruned early and rewritten on the next read.
  }
  return now
}

/** Write-once publish: a crash mid-write leaves only a temp file, never a truncated entry. */
function publishCacheEntry(filePath: string, bytes: Buffer): void {
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, bytes, { mode: PRIVATE_FILE_MODE })
    try {
      linkSync(tempPath, filePath)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return
      }
      // No hard links on this volume: rename is still atomic, and a same-name entry holds the same bytes.
      try {
        renameSync(tempPath, filePath)
      } catch (renameError) {
        if (!existsSync(filePath)) {
          throw renameError
        }
      }
    }
  } finally {
    rmSync(tempPath, { force: true })
  }
}

function hydrateBlock(block: NativeChatBlock, cacheDir: string, refKey: string): NativeChatBlock {
  if (!isInlineImageRef(block)) {
    return block
  }
  try {
    const url = block.url ?? ''
    // Transcript records are immutable, so length plus tail is enough to catch a reused id.
    const memoKey = `${refKey}\0${url.length}\0${url.slice(-64)}`
    const remembered = hydratedRefPaths.get(memoKey)
    if (remembered && existsSync(remembered.path)) {
      const now = Date.now()
      const touchedAt =
        now - remembered.touchedAt > TOUCH_INTERVAL_MS
          ? touchCacheEntry(remembered.path, now)
          : remembered.touchedAt
      rememberHydratedRef(memoKey, remembered.path, touchedAt)
      return { type: 'image-ref', path: remembered.path, ...(block.alt ? { alt: block.alt } : {}) }
    }
    const parsed = parseInlineImage(url)
    if (!parsed) {
      return block
    }
    const digest = createHash('sha256').update(parsed.bytes).digest('hex')
    const filePath = join(cacheDir, `${digest}.${extensionForMimeType(parsed.mimeType)}`)
    const now = Date.now()
    if (existsSync(filePath)) {
      touchCacheEntry(filePath, now)
    } else {
      publishCacheEntry(filePath, parsed.bytes)
    }
    tightenPathMode(filePath, PRIVATE_FILE_MODE)
    rememberHydratedRef(memoKey, filePath, now)
    return {
      type: 'image-ref',
      path: filePath,
      ...(block.alt ? { alt: block.alt } : {})
    }
  } catch {
    return block
  }
}

/**
 * Read one cache entry back for a remote client. Only a content-hash file directly
 * inside the cache dir is served, so a client cannot turn this into a host file read.
 */
export async function readNativeChatCachedImage(
  path: string,
  options: { maxBytes: number; cacheDir?: string }
): Promise<RuntimeFilePreviewResult> {
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const name = basename(path)
  const extension = CACHE_FILE_NAME.exec(name)?.[1]
  if (!extension || resolve(path) !== join(resolve(cacheDir), name)) {
    throw new Error('image_not_found')
  }
  let bytes: Buffer
  try {
    bytes = (await readNodeFileWithinLimit(join(cacheDir, name), options.maxBytes)).buffer
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      throw new Error('file_too_large')
    }
    throw new Error('image_not_found')
  }
  return {
    content: bytes.toString('base64'),
    isBinary: true,
    isImage: true,
    mimeType: MIME_TYPE_BY_EXTENSION[extension]
  }
}
