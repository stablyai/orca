import { open, type FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'
import { detectImageFileSignature } from '../../shared/file-content/image-file-signature'
import { buildImageDataUri } from '../../shared/file-preview/image-data-uri'
import { readRasterImageDimensions } from '../../shared/file-preview/raster-image-dimensions'
import { isRasterImagePreviewDimensions } from '../../shared/file-preview/raster-image-preview-limits'
import {
  MAX_REPO_ICON_DATA_URL_LENGTH,
  MAX_REPO_ICON_INPUT_BYTES,
  MAX_REPO_ICON_UPLOAD_BYTES
} from '../../shared/repository/appearance/repo-icon'
import {
  repoIconPickFailure,
  type RepoIconPickFailure
} from '../../shared/repository/appearance/repo-icon-pick-failure-copy'
import type {
  RepoIconPickDirectResult,
  RepoIconPreviewResult
} from '../../shared/repository/appearance/repo-icon-pick-result'
import { formatBytes } from '../../shared/text/format-bytes'
import { encodeRepoIconPngWithinLimit } from '../host/electron-repo-icon-png'

// Bound the native decode; the shared preview limit alone still allows 128MiB of pixels.
const MAX_REPO_ICON_INPUT_EDGE_PX = 8192
export const REPO_ICON_INPUT_LIMIT_LABEL = formatBytes(MAX_REPO_ICON_INPUT_BYTES)
export const REPO_ICON_STORAGE_LIMIT_LABEL = formatBytes(MAX_REPO_ICON_UPLOAD_BYTES)

type BoundedRepoIconFile = {
  buffer: Buffer
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

const isRepoIconPickFailure = (
  value: BoundedRepoIconFile | RepoIconPickFailure
): value is RepoIconPickFailure => 'ok' in value && value.ok === false

async function readBoundedHandleBytes(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset)
    if (bytesRead <= 0) {
      break
    }
    offset += bytesRead
  }
  return offset === size ? buffer : buffer.subarray(0, offset)
}

/** Rechecks the sender's remembered path on one handle, so a replaced or growing file cannot exceed the cap. */
async function readBoundedRepoIconFile(
  filePath: string
): Promise<BoundedRepoIconFile | RepoIconPickFailure> {
  let handle: FileHandle | null = null
  try {
    handle = await open(filePath, 'r')
    const info = await handle.stat()
    const size = info.size
    if (!info.isFile() || size <= 0) {
      return repoIconPickFailure('invalidImage')
    }
    if (size > MAX_REPO_ICON_INPUT_BYTES) {
      return repoIconPickFailure('tooLarge', { limit: REPO_ICON_INPUT_LIMIT_LABEL })
    }
    const buffer = await readBoundedHandleBytes(handle, size)

    return inspectBoundedRepoIconBuffer(buffer)
  } catch {
    return repoIconPickFailure('invalidImage')
  } finally {
    await handle?.close().catch(() => {})
  }
}

function inspectBoundedRepoIconBuffer(buffer: Buffer): BoundedRepoIconFile | RepoIconPickFailure {
  const signature = detectImageFileSignature(buffer)
  if (signature?.mimeType !== 'image/png' && signature?.mimeType !== 'image/jpeg') {
    return repoIconPickFailure('notPng')
  }
  const dimensions = readRasterImageDimensions(buffer)
  if (!dimensions) {
    return repoIconPickFailure('invalidImage')
  }
  if (
    dimensions.width > MAX_REPO_ICON_INPUT_EDGE_PX ||
    dimensions.height > MAX_REPO_ICON_INPUT_EDGE_PX ||
    !isRasterImagePreviewDimensions(dimensions)
  ) {
    return repoIconPickFailure('dimensionsTooLarge')
  }

  return {
    buffer,
    mimeType: signature.mimeType,
    width: dimensions.width,
    height: dimensions.height
  }
}

/** Existing direct path: a small valid PNG becomes a data URL with no re-encoding. */
export async function readDirectRepoIconPng(
  filePath: string
): Promise<RepoIconPickDirectResult | RepoIconPickFailure> {
  const file = await readBoundedRepoIconFile(filePath)
  if (isRepoIconPickFailure(file)) {
    return file
  }
  if (file.mimeType !== 'image/png') {
    return repoIconPickFailure('notPng')
  }
  if (file.buffer.byteLength > MAX_REPO_ICON_UPLOAD_BYTES) {
    return repoIconPickFailure('cannotCompress', { limit: REPO_ICON_STORAGE_LIMIT_LABEL })
  }
  const dataUrl = buildImageDataUri('image/png', file.buffer.toString('base64'))
  if (!dataUrl) {
    return repoIconPickFailure('invalidImage')
  }
  return dataUrl.length <= MAX_REPO_ICON_DATA_URL_LENGTH
    ? { kind: 'direct', dataUrl, fileName: basename(filePath) }
    : repoIconPickFailure('cannotCompress', { limit: REPO_ICON_STORAGE_LIMIT_LABEL })
}

/** The only full decode/encode path; returns the exact PNG the preview must persist. */
export async function readRepoIconPreview(filePath: string): Promise<RepoIconPreviewResult> {
  const file = await readBoundedRepoIconFile(filePath)
  if (isRepoIconPickFailure(file)) {
    return file
  }

  const converted = encodeRepoIconPngWithinLimit(file.buffer, MAX_REPO_ICON_UPLOAD_BYTES)
  if (!converted) {
    return repoIconPickFailure('cannotCompress', { limit: REPO_ICON_STORAGE_LIMIT_LABEL })
  }
  const dataUrl = buildImageDataUri('image/png', Buffer.from(converted.bytes).toString('base64'))
  if (!dataUrl || dataUrl.length > MAX_REPO_ICON_DATA_URL_LENGTH) {
    return repoIconPickFailure('cannotCompress', { limit: REPO_ICON_STORAGE_LIMIT_LABEL })
  }

  return {
    dataUrl,
    bytes: converted.bytes.byteLength,
    width: converted.width,
    height: converted.height
  }
}
