import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { constants, lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, parse, resolve } from 'node:path'
import {
  RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR,
  assertRasterImagePreviewWithinLimits
} from '../../shared/raster-image-preview-limits'
import type {
  OrcaBackgroundImageLoadResult,
  OrcaBackgroundImportResult,
  OrcaBackgroundLibrary,
  OrcaBackgroundLibraryImage,
  OrcaBackgroundOpenLibraryResult
} from '../../shared/orca-background-library-types'

const ORCA_BACKGROUND_LIBRARY_DIR_NAME = 'backgrounds'
const ORCA_BACKGROUND_MAX_BYTES = 12 * 1024 * 1024
const ORCA_BACKGROUND_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}
const ORCA_BACKGROUND_DIALOG_EXTENSIONS = Object.keys(ORCA_BACKGROUND_MIME_BY_EXTENSION).map(
  (extension) => extension.slice(1)
)

function backgroundLibraryDir(): string {
  return join(app.getPath('userData'), ORCA_BACKGROUND_LIBRARY_DIR_NAME)
}

function mimeTypeForFileName(fileName: string): string | null {
  return ORCA_BACKGROUND_MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ?? null
}

function isSafeFileName(fileName: unknown): fileName is string {
  return (
    typeof fileName === 'string' &&
    fileName.length > 0 &&
    fileName.length <= 255 &&
    basename(fileName) === fileName &&
    !fileName.includes('/') &&
    !fileName.includes('\\') &&
    !fileName.includes('\0') &&
    fileName !== '.' &&
    fileName !== '..'
  )
}

type ValidatedImageReadResult =
  | { ok: true; data: Uint8Array; mimeType: string; size: number }
  | { ok: false; reason: 'too-large' | 'read-failed' }

async function readValidatedImage(pathValue: string): Promise<ValidatedImageReadResult> {
  const mimeType = mimeTypeForFileName(pathValue)
  if (!mimeType) {
    return { ok: false, reason: 'read-failed' }
  }
  let handle
  try {
    const initialStats = await lstat(pathValue)
    if (!initialStats.isFile() || initialStats.isSymbolicLink() || initialStats.size === 0) {
      return { ok: false, reason: 'read-failed' }
    }
    if (initialStats.size > ORCA_BACKGROUND_MAX_BYTES) {
      return { ok: false, reason: 'too-large' }
    }
    // O_NOFOLLOW closes the lstat/open race on Unix; the lstat check rejects links on Windows.
    handle = await open(pathValue, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size === 0) {
      return { ok: false, reason: 'read-failed' }
    }
    if (stats.size > ORCA_BACKGROUND_MAX_BYTES) {
      return { ok: false, reason: 'too-large' }
    }
    const data = await handle.readFile()
    if (data.byteLength === 0) {
      return { ok: false, reason: 'read-failed' }
    }
    if (data.byteLength > ORCA_BACKGROUND_MAX_BYTES) {
      return { ok: false, reason: 'too-large' }
    }
    const bytes = Uint8Array.from(data)
    assertRasterImagePreviewWithinLimits(bytes, mimeType)
    return { ok: true, data: bytes, mimeType, size: data.byteLength }
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.message === RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR
          ? 'too-large'
          : 'read-failed'
    }
  } finally {
    await handle?.close()
  }
}

export async function listOrcaBackgroundLibrary(
  dir = backgroundLibraryDir()
): Promise<OrcaBackgroundLibrary> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { dir, images: [] }
  }

  const images: OrcaBackgroundLibraryImage[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !isSafeFileName(entry.name)) {
      continue
    }
    const path = join(dir, entry.name)
    const inspected = await readValidatedImage(path)
    if (inspected.ok) {
      images.push({ fileName: entry.name, path, size: inspected.size })
    }
  }
  return {
    dir,
    images: images.sort((left, right) => left.fileName.localeCompare(right.fileName))
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  )
}

async function writeImportedImage(
  dir: string,
  requestedFileName: string,
  data: Uint8Array
): Promise<string> {
  const parsed = parse(requestedFileName)
  for (let index = 1; index < 10_000; index += 1) {
    const fileName = index === 1 ? requestedFileName : `${parsed.name}-${index}${parsed.ext}`
    try {
      await writeFile(join(dir, fileName), data, { flag: 'wx' })
      return fileName
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error
      }
    }
  }
  throw new Error('Background library contains too many files with the same name')
}

export async function importOrcaBackgroundImages(
  sourcePaths: readonly string[],
  dir = backgroundLibraryDir()
): Promise<OrcaBackgroundImportResult> {
  await mkdir(dir, { recursive: true })
  const added: string[] = []
  const skipped: string[] = []

  for (const sourcePath of sourcePaths) {
    const sourceFileName = basename(sourcePath)
    const image = isSafeFileName(sourceFileName)
      ? await readValidatedImage(sourcePath)
      : ({ ok: false, reason: 'read-failed' } as const)
    if (!image.ok) {
      skipped.push(sourceFileName || 'unknown')
      continue
    }
    if (resolve(sourcePath) === resolve(join(dir, sourceFileName))) {
      added.push(sourceFileName)
      continue
    }
    try {
      added.push(await writeImportedImage(dir, sourceFileName, image.data))
    } catch {
      skipped.push(sourceFileName)
    }
  }

  return { ...(await listOrcaBackgroundLibrary(dir)), added, skipped }
}

export async function loadOrcaBackgroundImage(
  fileName: unknown,
  dir = backgroundLibraryDir()
): Promise<OrcaBackgroundImageLoadResult> {
  if (!isSafeFileName(fileName)) {
    return { ok: false, reason: 'invalid-name' }
  }
  const mimeType = mimeTypeForFileName(fileName)
  if (!mimeType) {
    return { ok: false, reason: 'unsupported-type' }
  }
  const path = join(dir, fileName)
  let stats
  try {
    stats = await lstat(path)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { ok: false, reason: 'invalid-name' }
  }
  if (stats.size > ORCA_BACKGROUND_MAX_BYTES) {
    return { ok: false, reason: 'too-large' }
  }
  const image = await readValidatedImage(path)
  if (!image.ok) {
    return image
  }
  return { ok: true, data: image.data, mimeType }
}

export async function openOrcaBackgroundLibrary(
  dir = backgroundLibraryDir()
): Promise<OrcaBackgroundOpenLibraryResult> {
  try {
    await mkdir(dir, { recursive: true })
    const error = await shell.openPath(dir)
    return error ? { ok: false, reason: 'open-failed' } : { ok: true }
  } catch {
    return { ok: false, reason: 'open-failed' }
  }
}

export function registerOrcaBackgroundLibraryHandlers(): void {
  ipcMain.handle('backgrounds:listLibrary', () => listOrcaBackgroundLibrary())
  ipcMain.handle('backgrounds:addImages', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ORCA_BACKGROUND_DIALOG_EXTENSIONS }]
    }
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return importOrcaBackgroundImages(picked.canceled ? [] : picked.filePaths)
  })
  ipcMain.handle('backgrounds:openLibrary', () => openOrcaBackgroundLibrary())
  ipcMain.handle('backgrounds:loadImage', (_event, fileName: unknown) =>
    loadOrcaBackgroundImage(fileName)
  )
}
