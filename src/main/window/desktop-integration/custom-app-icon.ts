import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, nativeImage } from 'electron'
import {
  CUSTOM_APP_ICON_MAX_BYTES,
  CUSTOM_APP_ICON_MAX_SIDE,
  CUSTOM_APP_ICON_MIN_SIDE,
  type CustomAppIconImportFailureCode,
  type CustomAppIconImportResult
} from '../../../shared/app-icon'
import { readRasterImageDimensions } from '../../../shared/raster-image-dimensions'

// Why: 1024px covers the largest Dock and taskbar tiles; larger images only cost memory on every apply.
const STORED_ICON_SIDE = 1024
const PREVIEW_ICON_SIDE = 192

type CustomAppIconFormat = 'png' | 'jpeg' | 'ico'

export function getCustomAppIconPath(): string {
  return join(app.getPath('userData'), 'app-icon', 'custom.png')
}

export function hasCustomAppIcon(): boolean {
  return existsSync(getCustomAppIconPath())
}

export function customAppIconFileExtensions(
  platform: NodeJS.Platform = process.platform
): string[] {
  // Electron decodes ICO only on Windows, so other platforms never offer it.
  return platform === 'win32' ? ['png', 'jpg', 'jpeg', 'ico'] : ['png', 'jpg', 'jpeg']
}

function sniffFormat(bytes: Uint8Array): CustomAppIconFormat | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png'
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'jpeg'
  }
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return 'ico'
  }
  return null
}

class CustomAppIconImportError extends Error {
  constructor(readonly code: CustomAppIconImportFailureCode) {
    super(code)
  }
}

function previewDataUrl(image: Electron.NativeImage): string {
  return image.resize({ width: PREVIEW_ICON_SIDE, height: PREVIEW_ICON_SIDE }).toDataURL()
}

async function decodeCustomAppIcon(sourcePath: string): Promise<Electron.NativeImage> {
  const sourceStat = await stat(sourcePath).catch(() => null)
  if (!sourceStat?.isFile()) {
    throw new CustomAppIconImportError('unreadable')
  }
  if (sourceStat.size > CUSTOM_APP_ICON_MAX_BYTES) {
    throw new CustomAppIconImportError('tooLarge')
  }
  const bytes = await readFile(sourcePath).catch(() => {
    throw new CustomAppIconImportError('unreadable')
  })
  const format = sniffFormat(bytes)
  if (!format || (format === 'ico' && process.platform !== 'win32')) {
    throw new CustomAppIconImportError('unsupportedFormat')
  }
  // Read the header before decoding so a decompression bomb never reaches the native decoder.
  const dimensions = readRasterImageDimensions(bytes)
  if (!dimensions) {
    throw new CustomAppIconImportError('undecodable')
  }
  if (dimensions.width !== dimensions.height) {
    throw new CustomAppIconImportError('notSquare')
  }
  if (dimensions.width < CUSTOM_APP_ICON_MIN_SIDE) {
    throw new CustomAppIconImportError('tooSmall')
  }
  if (dimensions.width > CUSTOM_APP_ICON_MAX_SIDE) {
    throw new CustomAppIconImportError('tooBig')
  }
  const image =
    format === 'ico' ? nativeImage.createFromPath(sourcePath) : nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) {
    throw new CustomAppIconImportError('undecodable')
  }
  return image.getSize().width > STORED_ICON_SIDE
    ? image.resize({ width: STORED_ICON_SIDE, height: STORED_ICON_SIDE, quality: 'best' })
    : image
}

/** Validates the picked image and stores it as a normalized PNG inside userData. */
export async function importCustomAppIcon(sourcePath: string): Promise<CustomAppIconImportResult> {
  let image: Electron.NativeImage
  try {
    image = await decodeCustomAppIcon(sourcePath)
  } catch (error) {
    if (error instanceof CustomAppIconImportError) {
      return { ok: false, code: error.code }
    }
    throw error
  }
  const destination = getCustomAppIconPath()
  const staging = `${destination}.tmp`
  try {
    await mkdir(dirname(destination), { recursive: true })
    // Re-encoding drops any metadata or trailing payload the source file carried.
    await writeFile(staging, image.toPNG())
    await rename(staging, destination)
  } catch (error) {
    console.warn('[app-icon] failed to save custom app icon:', error)
    await rm(staging, { force: true }).catch(() => {})
    return { ok: false, code: 'saveFailed' }
  }
  return { ok: true, previewDataUrl: previewDataUrl(image) }
}

export function readCustomAppIconPreview(): string | null {
  if (!hasCustomAppIcon()) {
    return null
  }
  const image = nativeImage.createFromPath(getCustomAppIconPath())
  return image.isEmpty() ? null : previewDataUrl(image)
}

export async function removeCustomAppIcon(): Promise<void> {
  await rm(getCustomAppIconPath(), { force: true })
}
