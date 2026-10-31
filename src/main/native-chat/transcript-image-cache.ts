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
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { base64DecodedByteLength } from '../../shared/agent-session-attachments'
import type {
  NativeChatBlock,
  NativeChatImageRefBlock,
  NativeChatMessage
} from '../../shared/native-chat-types'
import { isKnownRasterImageMimeType } from '../../shared/raster-image-preview-limits'
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  tightenPathMode
} from '../daemon/daemon-private-file-modes'

// Bound transient decoding and disk use per screenshot.
export const NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES = 8 * 1024 * 1024
const CACHE_DIR_NAME = 'native-chat-images'
const CACHE_FILE_NAME = /^[0-9a-f]{64}\.(png|jpg|gif|webp|bmp|ico)$/

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
  if (
    payload.length === 0 ||
    payload.length % 4 !== 0 ||
    base64DecodedByteLength(payload) > NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)
  ) {
    return null
  }
  const bytes = Buffer.from(payload, 'base64')
  return bytes.length > 0 ? { mimeType, bytes } : null
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

/** Cache inline images as host paths; a cache failure keeps desktop's inline fallback. */
export function hydrateNativeChatImageRefs(
  messages: readonly NativeChatMessage[],
  options: { cacheDir?: string } = {}
): NativeChatMessage[] {
  if (!messages.some((message) => message.blocks.some(isInlineImageRef))) {
    return [...messages]
  }
  let cacheDir: string
  try {
    cacheDir = options.cacheDir ?? join(getAppEnvironment().getPath('userData'), CACHE_DIR_NAME)
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
      blocks: message.blocks.map((block) => hydrateBlock(block, cacheDir))
    }
  })
}

// Weak keys reuse unchanged blocks without retaining images after their transcript is released.
const hydratedRefPaths = new WeakMap<
  NativeChatImageRefBlock,
  { url: string; cacheDir: string; path: string; touchedAt: number }
>()

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

function hydrateBlock(block: NativeChatBlock, cacheDir: string): NativeChatBlock {
  if (!isInlineImageRef(block)) {
    return block
  }
  try {
    const url = block.url ?? ''
    const remembered = hydratedRefPaths.get(block)
    const now = Date.now()
    let filePath: string
    if (
      remembered?.url === url &&
      remembered.cacheDir === cacheDir &&
      existsSync(remembered.path)
    ) {
      filePath = remembered.path
      if (now - remembered.touchedAt > TOUCH_INTERVAL_MS) {
        remembered.touchedAt = touchCacheEntry(filePath, now)
      }
    } else {
      const parsed = parseInlineImage(url)
      if (!parsed) {
        return block
      }
      const digest = createHash('sha256').update(parsed.bytes).digest('hex')
      filePath = join(cacheDir, `${digest}.${extensionForMimeType(parsed.mimeType)}`)
      if (existsSync(filePath)) {
        touchCacheEntry(filePath, now)
      } else {
        publishCacheEntry(filePath, parsed.bytes)
      }
      tightenPathMode(filePath, PRIVATE_FILE_MODE)
      hydratedRefPaths.set(block, { url, cacheDir, path: filePath, touchedAt: now })
    }
    return {
      type: 'image-ref',
      path: filePath,
      ...(block.alt ? { alt: block.alt } : {})
    }
  } catch {
    return block
  }
}
