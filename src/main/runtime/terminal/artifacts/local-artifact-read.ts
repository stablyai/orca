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
import type { RuntimeFilePreviewResult } from '../../../../shared/runtime-types'

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
  const mimeType = RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES[extname(grant.absolutePath).toLowerCase()]
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
      isImage: true,
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
