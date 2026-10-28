import { readFile, stat } from 'node:fs/promises'
import { crc32, deflateSync } from 'node:zlib'
import type { BrowserExtensionActionIcon } from './browser-extension-action-state'
import { resolveInsideExtensionDirectory } from './browser-extension-manifest'

/** Toolbar icons draw at 16 CSS px; 32 covers 2x displays. */
const TOOLBAR_ICON_PIXELS = 32
const MAX_ICON_BYTES = 512 * 1024
const MAX_IMAGE_DATA_SIDE = 256
const ICON_MIME_BY_SUFFIX: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

/** ImageData as the preload sends it: the main world flattens `data` to a plain array. */
export type SerializedImageData = { width: number; height: number; data: number[] }

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typed) >>> 0)
  return Buffer.concat([length, typed, checksum])
}

/** Encodes straight RGBA pixels (ImageData's layout) as a PNG. */
export function encodeRgbaPng(width: number, height: number, rgba: ArrayLike<number>): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8) // bit depth
  header.writeUInt8(6, 9) // colour type: RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    // Filter byte 0 (none) starts every scanline.
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x] ?? 0
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function isSerializedImageData(value: unknown): value is SerializedImageData {
  if (value === null || typeof value !== 'object' || !('data' in value)) {
    return false
  }
  const { width, height, data } = { width: undefined, height: undefined, ...value }
  return (
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    Array.isArray(data) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DATA_SIDE &&
    height <= MAX_IMAGE_DATA_SIDE &&
    data.length === width * height * 4
  )
}

/** setIcon({imageData}): one ImageData or a size → ImageData map; keeps the best toolbar size. */
export function iconFromImageData(input: unknown): BrowserExtensionActionIcon | null {
  const candidates: SerializedImageData[] = isSerializedImageData(input)
    ? [input]
    : input !== null && typeof input === 'object'
      ? Object.values(input).filter(isSerializedImageData)
      : []
  const chosen = pickToolbarSize(candidates.map((image) => ({ size: image.width, value: image })))
  if (!chosen) {
    return null
  }
  const png = encodeRgbaPng(chosen.width, chosen.height, chosen.data)
  return { kind: 'data', dataUrl: `data:image/png;base64,${png.toString('base64')}` }
}

/** The smallest icon at least toolbar-sized, else the largest. */
export function pickToolbarSize<T>(entries: { size: number; value: T }[]): T | null {
  const sorted = [...entries].sort((a, b) => a.size - b.size)
  return (sorted.find((entry) => entry.size >= TOOLBAR_ICON_PIXELS) ?? sorted.at(-1))?.value ?? null
}

const iconCache = new Map<string, Promise<string | null>>()

async function readIconFile(directory: string, relativePath: string): Promise<string | null> {
  const absolute = resolveInsideExtensionDirectory(directory, relativePath)
  const suffix = absolute?.split('.').at(-1)?.toLowerCase() ?? ''
  const mime = ICON_MIME_BY_SUFFIX[suffix]
  if (!absolute || !mime) {
    return null
  }
  try {
    if ((await stat(absolute)).size > MAX_ICON_BYTES) {
      return null
    }
    return `data:${mime};base64,${(await readFile(absolute)).toString('base64')}`
  } catch {
    return null
  }
}

/** Resolves an action icon to a data URL the renderer can show; file reads are cached per path. */
export function resolveActionIconDataUrl(
  extensionDirectory: string,
  icon: BrowserExtensionActionIcon | null
): Promise<string | null> {
  if (!icon) {
    return Promise.resolve(null)
  }
  if (icon.kind === 'data') {
    return Promise.resolve(icon.dataUrl)
  }
  const path = pickToolbarSize(
    Object.entries(icon.paths).map(([size, value]) => ({
      size: Number.parseInt(size, 10) || 0,
      value
    }))
  )
  if (!path) {
    return Promise.resolve(null)
  }
  const key = `${extensionDirectory}\0${path}`
  let cached = iconCache.get(key)
  if (!cached) {
    cached = readIconFile(extensionDirectory, path)
    iconCache.set(key, cached)
  }
  return cached
}

/** An unpacked folder can change on disk; reloads must not keep serving the old bytes. */
export function forgetActionIconCache(extensionDirectory: string): void {
  for (const key of iconCache.keys()) {
    if (key.startsWith(`${extensionDirectory}\0`)) {
      iconCache.delete(key)
    }
  }
}
