import type { RuntimeFileReadChunkResult } from '../../../shared/runtime-types'
import { openLocalRegularFile } from './local-regular-file-read'

export async function readLocalFileRange(
  filePath: string,
  offset: number,
  length: number
): Promise<RuntimeFileReadChunkResult> {
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
  const { handle, stats } = await openLocalRegularFile(filePath)
  try {
    const buffer = Buffer.alloc(Math.min(length, Math.max(0, stats.size - offset)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    return {
      contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
      bytesRead,
      eof: offset + bytesRead >= stats.size
    }
  } finally {
    await handle.close()
  }
}
