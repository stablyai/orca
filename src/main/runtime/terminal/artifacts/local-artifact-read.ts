import { open, constants, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import type { TerminalFileContentBlocks, TerminalFileGrant } from './file-grants'
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
  readFileHandleBufferBounded,
  TERMINAL_ARTIFACT_CONTENT_BLOCK_BYTES,
  terminalArtifactContentDigest
} from './artifact-integrity'
import { BINARY_PROBE_BYTES, isBinaryBuffer } from '../../../../shared/binary-buffer'
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
  assertTerminalFileGrantFresh(grant, fileStat)
  if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
    // Why: as files.read does, name a binary before its size refuses it, so no reader pages it as text.
    const probe = await readFileHandleBufferBounded(handle, BINARY_PROBE_BYTES)
    throw new Error(isBinaryBuffer(probe) ? 'binary_file' : 'file_too_large')
  }
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
  if (grant.contentDigest !== null && grant.contentBlocks && fileStats.size > 0) {
    return readVerifiedBlocksPage(
      handle,
      grant,
      grant.contentBlocks,
      fileStats.size,
      offset,
      length
    )
  }
  if (grant.contentDigest !== null) {
    // Why: procfs sizes read as 0, so only a whole read sees (and verifies) the content.
    assertFileReadRange(offset, length)
    const buffer = await readFileHandleBufferBounded(handle, LOCAL_PREVIEWABLE_BINARY_MAX_BYTES + 1)
    assertTerminalArtifactContentUnchanged(grant, buffer)
    return fileRangePage(buffer.subarray(offset, offset + length), offset, buffer.byteLength)
  }
  const page = await readFileHandleRange(handle, fileStats.size, offset, length)
  // Why: a file rewritten during this read must not land a torn page.
  assertTerminalFileGrantFresh(grant, await handle.stat())
  return page
}

/** Reads the blocks a page touches and checks each against the grant, so no page carries unpinned bytes. */
async function readVerifiedBlocksPage(
  handle: FileHandle,
  grant: TerminalFileGrant,
  blocks: TerminalFileContentBlocks,
  size: number,
  offset: number,
  length: number
): Promise<RuntimeFileReadChunkResult> {
  assertFileReadRange(offset, length)
  if (size !== blocks.byteLength) {
    throw new Error('terminal_file_grant_stale')
  }
  if (offset >= size) {
    return fileRangePage(Buffer.alloc(0), offset, size)
  }
  const blockBytes = TERMINAL_ARTIFACT_CONTENT_BLOCK_BYTES
  const firstBlock = Math.floor(offset / blockBytes)
  const readStart = firstBlock * blockBytes
  const readEnd = Math.min(size, Math.ceil((offset + length) / blockBytes) * blockBytes)
  const buffer = Buffer.alloc(readEnd - readStart)
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, readStart)
  if (bytesRead !== buffer.length) {
    throw new Error('terminal_file_grant_stale')
  }
  for (let start = 0; start < buffer.length; start += blockBytes) {
    const digest = terminalArtifactContentDigest(buffer.subarray(start, start + blockBytes))
    if (digest !== blocks.digests[firstBlock + start / blockBytes]) {
      throw new Error('terminal_file_grant_stale')
    }
  }
  // Why: a file rewritten during this read must not land a torn page.
  assertTerminalFileGrantFresh(grant, await handle.stat())
  return fileRangePage(
    buffer.subarray(offset - readStart, offset - readStart + length),
    offset,
    size
  )
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
