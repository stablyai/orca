import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { chmod, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  IMAGE_MIME_TYPES,
  isBinaryBuffer,
  MAX_PREVIEWABLE_BINARY_SIZE,
  MAX_TEXT_FILE_SIZE
} from './fs-handler-utils'
import { assertRasterImagePreviewWithinLimits } from '../shared/raster-image-preview-limits'

type TerminalArtifactStat = {
  size: number
  type: 'file' | 'directory' | 'symlink'
  mtime: number
  mtimeMs: number
  mode?: number
  dev?: number
  ino?: number
  nlink?: number
}

type VerifiedTerminalArtifactOptions = {
  expectedRealPath: string
  expectedStatIdentity?: string | null
  maxBytes?: number
}

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

export async function readVerifiedTerminalArtifact(params: Record<string, unknown>) {
  const filePath = stringParam(params.filePath)
  const options = verifiedTerminalArtifactOptions(params)
  const handle = await openVerifiedTerminalArtifact(filePath, options, constants.O_RDONLY)
  try {
    await verifiedHandleStat(handle, options)
    const mimeType = terminalArtifactImageMimeType(filePath)
    const sizeLimit = Math.min(
      options.maxBytes ?? (mimeType ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE),
      mimeType ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
    )
    const buffer = await readBoundedFileFromHandle(handle, sizeLimit)
    if (mimeType) {
      const imageDimensions = assertRasterImagePreviewWithinLimits(buffer, mimeType)
      return {
        content: buffer.toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType,
        ...(imageDimensions ? { imageDimensions } : {})
      }
    }
    if (isBinaryBuffer(buffer)) {
      return { content: '', isBinary: true }
    }
    return { content: buffer.toString('utf-8'), isBinary: false }
  } finally {
    await handle.close()
  }
}

export async function writeVerifiedTerminalArtifact(
  params: Record<string, unknown>
): Promise<{ ok: true; stat: TerminalArtifactStat }> {
  const filePath = stringParam(params.filePath)
  const content = stringParam(params.content)
  const options = verifiedTerminalArtifactOptions(params)
  // Why: maxBytes is client-supplied; clamp before it sizes buffer allocations.
  const writeLimit = Math.min(options.maxBytes ?? MAX_TEXT_FILE_SIZE, MAX_TEXT_FILE_SIZE)
  if (Buffer.byteLength(content, 'utf8') > writeLimit) {
    throw new Error('file_too_large')
  }
  const handle = await openVerifiedTerminalArtifact(filePath, options, constants.O_RDONLY)
  let originalMode: number | null = null
  try {
    originalMode = (await verifiedHandleStat(handle, options)).mode ?? null
    const existing = await readBoundedFileFromHandle(handle, writeLimit)
    if (isBinaryBuffer(existing)) {
      throw new Error('binary_file')
    }
  } finally {
    await handle.close()
  }
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' })
    if (typeof originalMode === 'number') {
      await chmod(tempPath, originalMode & 0o7777)
    }
    const freshHandle = await openVerifiedTerminalArtifact(filePath, options, constants.O_RDONLY)
    try {
      await verifiedHandleStat(freshHandle, options)
    } finally {
      await freshHandle.close()
    }
    await rename(tempPath, filePath)
    return { ok: true, stat: fileStatFromHandleStats(await openStatClose(filePath)) }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

async function openStatClose(filePath: string): Promise<Stats> {
  const handle = await open(filePath, constants.O_RDONLY)
  try {
    return await handle.stat()
  } finally {
    await handle.close()
  }
}

function terminalArtifactImageMimeType(filePath: string): string | undefined {
  const mimeType = IMAGE_MIME_TYPES[extname(filePath).toLowerCase()]
  // Why: mobile renders SVG terminal artifacts as source text; returning image
  // data from the relay would make SSH disagree with local artifact previews.
  return mimeType === 'image/svg+xml' ? undefined : mimeType
}

async function readBoundedFileFromHandle(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const safeLimit = Math.max(0, Math.floor(maxBytes))
  const buffer = Buffer.alloc(safeLimit + 1)
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
  if (bytesRead > safeLimit) {
    throw new Error('file_too_large')
  }
  return buffer.subarray(0, bytesRead)
}

async function openVerifiedTerminalArtifact(
  filePath: string,
  options: VerifiedTerminalArtifactOptions,
  flags: number
): Promise<FileHandle> {
  await assertRealPathStillGranted(filePath, options.expectedRealPath)
  try {
    return await open(filePath, flags | OPEN_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('terminal_file_grant_stale')
    }
    throw error
  }
}

async function verifiedHandleStat(
  handle: FileHandle,
  options: VerifiedTerminalArtifactOptions
): Promise<TerminalArtifactStat> {
  const stats = fileStatFromHandleStats(await handle.stat())
  if (stats.type !== 'file') {
    throw new Error(
      stats.type === 'directory' ? 'Cannot write to a directory' : 'terminal_file_grant_stale'
    )
  }
  assertTerminalArtifactNotHardLinked(stats)
  assertTerminalArtifactStatIdentity(options.expectedStatIdentity ?? null, stats)
  return stats
}

async function assertRealPathStillGranted(
  filePath: string,
  expectedRealPath: string
): Promise<void> {
  // Why: terminal artifacts are user-writable temp paths; the relay must check
  // canonicality in the same remote operation that opens the file handle.
  if ((await realpath(filePath)) !== expectedRealPath) {
    throw new Error('terminal_file_grant_stale')
  }
}

function fileStatFromHandleStats(stats: Stats): TerminalArtifactStat {
  let type: TerminalArtifactStat['type'] = 'file'
  if (stats.isDirectory()) {
    type = 'directory'
  } else if (stats.isSymbolicLink()) {
    type = 'symlink'
  }
  return {
    size: stats.size,
    type,
    mtime: stats.mtimeMs,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode,
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink
  }
}

function terminalArtifactStatIdentity(stats: {
  size?: number
  dev?: number
  ino?: number
  nlink?: number
  mtime?: number | Date
  mtimeMs?: number
}): string | null {
  const dev = typeof stats.dev === 'number' ? stats.dev : null
  const ino = typeof stats.ino === 'number' ? stats.ino : null
  const nlink = typeof stats.nlink === 'number' ? stats.nlink : null
  const size = typeof stats.size === 'number' ? stats.size : null
  const mtimeMs =
    typeof stats.mtimeMs === 'number'
      ? stats.mtimeMs
      : typeof stats.mtime === 'number'
        ? stats.mtime
        : null
  if (dev !== null && ino !== null && size !== null && mtimeMs !== null) {
    return `${dev}:${ino}:${nlink ?? 'unknown'}:${size}:${mtimeMs}`
  }
  if (size !== null && mtimeMs !== null) {
    return `${size}:${mtimeMs}`
  }
  return null
}

function assertTerminalArtifactNotHardLinked(stats: TerminalArtifactStat): void {
  if (typeof stats.nlink === 'number' && stats.nlink > 1) {
    throw new Error('terminal_file_grant_stale')
  }
}

function assertTerminalArtifactStatIdentity(
  expectedStatIdentity: string | null,
  stats: TerminalArtifactStat
): void {
  const nextIdentity = terminalArtifactStatIdentity(stats)
  if (
    expectedStatIdentity !== null &&
    nextIdentity !== null &&
    expectedStatIdentity !== nextIdentity
  ) {
    throw new Error('terminal_file_grant_stale')
  }
}

function verifiedTerminalArtifactOptions(
  params: Record<string, unknown>
): VerifiedTerminalArtifactOptions {
  return {
    expectedRealPath: stringParam(params.expectedRealPath),
    expectedStatIdentity:
      typeof params.expectedStatIdentity === 'string' ? params.expectedStatIdentity : null,
    maxBytes:
      typeof params.maxBytes === 'number' && Number.isFinite(params.maxBytes)
        ? Math.max(0, Math.floor(params.maxBytes))
        : undefined
  }
}

function stringParam(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('invalid_terminal_artifact_request')
  }
  return value
}
