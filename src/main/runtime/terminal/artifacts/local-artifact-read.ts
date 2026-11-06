import { createHash, type Hash } from 'node:crypto'
import { open, constants, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import type { TerminalFileGrant } from './file-grants'
import {
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  MOBILE_FILE_READ_MAX_BYTES,
  RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES,
  previewableBinaryByteLimit
} from '../../files/file-preview-budget'
import {
  assertTerminalArtifactContentUnchanged,
  assertTerminalFileGrantFresh,
  canonicalPathForArtifactComparison,
  readFileHandleBufferBounded
} from './artifact-integrity'
import { isBinaryBuffer } from '../../../../shared/binary-buffer'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult
} from '../../../../shared/runtime-types'
import { FONT_FILE_MIME_TYPES } from '../../../../shared/font-file-extensions'
import {
  assertFileReadRange,
  fileRangePage,
  readFileHandleRange
} from '../../../ipc/filesystem/local-file-range-read'

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

export async function readLocalTerminalArtifactFileFromHandle(
  handle: FileHandle,
  grant: TerminalFileGrant
): Promise<string> {
  const fileStat = await handle.stat()
  if (fileStat.isDirectory()) {
    throw new Error('Cannot read a directory')
  }
  if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
    throw new Error('file_too_large')
  }
  assertTerminalFileGrantFresh(grant, fileStat)
  const buffer = await readFileHandleBufferBounded(handle, MOBILE_FILE_READ_MAX_BYTES + 1)
  assertTerminalArtifactContentUnchanged(grant, buffer)
  if (isBinaryBuffer(buffer)) {
    throw new Error('binary_file')
  }
  return buffer.toString('utf8')
}

export async function readLocalTerminalArtifactPreviewFromHandle(
  handle: FileHandle,
  grant: TerminalFileGrant,
  maxContentBytes: number | undefined
): Promise<RuntimeFilePreviewResult> {
  const fileStats = await handle.stat()
  if (fileStats.isDirectory()) {
    throw new Error('Cannot preview a directory')
  }
  assertTerminalFileGrantFresh(grant, fileStats)
  const extension = extname(grant.absolutePath).toLowerCase()
  const fontMimeType = FONT_FILE_MIME_TYPES[extension]
  const mimeType = fontMimeType ?? RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES[extension]
  if (mimeType) {
    const binaryMaxBytes =
      maxContentBytes === undefined
        ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
        : previewableBinaryByteLimit(maxContentBytes)
    if (fileStats.size > binaryMaxBytes) {
      throw new Error('file_too_large')
    }
    const buffer = await readFileHandleBufferBounded(handle, binaryMaxBytes + 1)
    if (buffer.byteLength > binaryMaxBytes) {
      throw new Error('file_too_large')
    }
    assertTerminalArtifactContentUnchanged(grant, buffer)
    return {
      content: buffer.toString('base64'),
      isBinary: true,
      isImage: !fontMimeType,
      mimeType
    }
  }

  const content = await readLocalTerminalArtifactFileFromHandle(handle, grant)
  return { content, isBinary: false }
}

export async function assertLocalTerminalArtifactPathStillCanonical(
  filePath: string
): Promise<void> {
  const currentPath = await canonicalPathForArtifactComparison(filePath)
  if (currentPath !== filePath) {
    throw new Error('terminal_file_grant_stale')
  }
}

/** A page of a granted file; any type, since a download only moves its bytes. */
export async function readLocalTerminalArtifactRangeFromHandle(
  handle: FileHandle,
  grant: TerminalFileGrant,
  offset: number,
  length: number
): Promise<RuntimeFileReadChunkResult> {
  const fileStats = await handle.stat()
  if (!fileStats.isFile()) {
    throw new Error('Cannot read a directory')
  }
  assertTerminalFileGrantFresh(grant, fileStats)
  if (grant.contentDigest !== null) {
    assertFileReadRange(offset, length)
    const stream = sequentialDigestStream(grant, offset)
    // Why: procfs sizes read as 0, and out-of-order or concurrent paging has no running digest.
    if (fileStats.size === 0 || !stream) {
      const buffer = await readFileHandleBufferBounded(
        handle,
        LOCAL_PREVIEWABLE_BINARY_MAX_BYTES + 1
      )
      assertTerminalArtifactContentUnchanged(grant, buffer)
      return fileRangePage(buffer.subarray(offset, offset + length), offset, buffer.byteLength)
    }
    if (fileStats.size > LOCAL_PREVIEWABLE_BINARY_MAX_BYTES) {
      digestStreams.delete(grant)
      throw new Error('terminal_file_grant_stale')
    }
    const page = await readGrantPage(handle, grant, fileStats.size, offset, length)
    // Why: re-hashing the whole file per page made a 10 MiB download hash ~270 MiB; the
    // running digest over every delivered byte is checked on the EOF page, and the client
    // discards the download if that page fails.
    const bytes = Buffer.from(page.contentBase64, 'base64')
    stream.hash.update(bytes)
    stream.nextOffset += bytes.byteLength
    if (page.eof) {
      digestStreams.delete(grant)
      if (stream.hash.digest('hex') !== grant.contentDigest) {
        throw new Error('terminal_file_grant_stale')
      }
    }
    return page
  }
  return readGrantPage(handle, grant, fileStats.size, offset, length)
}

type GrantDigestStream = { nextOffset: number; hash: Hash }

// 'contended': two downloads of one grant interleaved, so pages fall back to whole-file checks.
const digestStreams = new WeakMap<TerminalFileGrant, GrantDigestStream | 'contended'>()

function sequentialDigestStream(
  grant: TerminalFileGrant,
  offset: number
): GrantDigestStream | null {
  const existing = digestStreams.get(grant)
  if (existing === 'contended') {
    return null
  }
  if (offset === 0) {
    if (existing && existing.nextOffset > 0) {
      digestStreams.set(grant, 'contended')
      return null
    }
    const stream = { nextOffset: 0, hash: createHash('sha256') }
    digestStreams.set(grant, stream)
    return stream
  }
  return existing && existing.nextOffset === offset ? existing : null
}

async function readGrantPage(
  handle: FileHandle,
  grant: TerminalFileGrant,
  size: number,
  offset: number,
  length: number
): Promise<RuntimeFileReadChunkResult> {
  const page = await readFileHandleRange(handle, size, offset, length)
  // Why: a file rewritten during this read must not land a torn page.
  assertTerminalFileGrantFresh(grant, await handle.stat())
  return page
}

export async function openLocalTerminalArtifactGrant(
  grant: TerminalFileGrant,
  flags: number
): Promise<FileHandle> {
  await assertLocalTerminalArtifactPathStillCanonical(grant.absolutePath)
  try {
    // Why: a path swapped for a FIFO would otherwise block a host threadpool thread.
    return await open(grant.absolutePath, flags | OPEN_NOFOLLOW | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOOP') {
      throw new Error('terminal_file_grant_stale')
    }
    throw error
  }
}
