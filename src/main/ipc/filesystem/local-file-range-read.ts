import type { FileHandle } from 'node:fs/promises'
import type { RuntimeFileReadChunkResult } from '../../../shared/runtime-types'
import { openLocalRegularFile } from './local-regular-file-read'

export async function readLocalFileRange(
  filePath: string,
  offset: number,
  length: number
): Promise<RuntimeFileReadChunkResult> {
  assertFileReadRange(offset, length)
  const { handle, stats } = await openLocalRegularFile(filePath)
  try {
    return await readFileHandleRange(handle, stats.size, offset, length)
  } finally {
    await handle.close()
  }
}

/** One page of an open file whose size the caller already checked. */
export async function readFileHandleRange(
  handle: FileHandle,
  size: number,
  offset: number,
  length: number
): Promise<RuntimeFileReadChunkResult> {
  assertFileReadRange(offset, length)
  const buffer = Buffer.alloc(Math.min(length, Math.max(0, size - offset)))
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
  return fileRangePage(buffer.subarray(0, bytesRead), offset, size)
}

/** The bytes at `offset` of a file of `size` bytes, as one page. */
export function fileRangePage(
  bytes: Buffer,
  offset: number,
  size: number
): RuntimeFileReadChunkResult {
  return {
    contentBase64: bytes.toString('base64'),
    bytesRead: bytes.byteLength,
    eof: offset + bytes.byteLength >= size
  }
}

export function assertFileReadRange(offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 512 * 1024 ||
    offset > Number.MAX_SAFE_INTEGER - (length - 1)
  ) {
    throw new Error('Invalid file read range')
  }
}
