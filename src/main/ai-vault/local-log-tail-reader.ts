import { open } from 'node:fs/promises'
import { LOCAL_READ_OPEN_FLAGS } from '../ipc/filesystem/local-regular-file-read'
import {
  LOCAL_LOG_TAIL_CHUNK_BYTES,
  type LocalLogTailReadResult
} from '../../shared/local-log-tail-types'

export function localLogFileIdentity(stats: {
  dev: number
  ino: number
  birthtimeMs: number
}): string {
  // Inodes detect POSIX replacement; birthtime covers filesystems with unusable inode values.
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
}

export async function readLocalLogTailRange(
  filePath: string,
  fromByteOffset: number,
  expectedIdentity?: string
): Promise<LocalLogTailReadResult> {
  if (!Number.isSafeInteger(fromByteOffset) || fromByteOffset < 0) {
    throw new Error('Invalid local log tail byte offset')
  }

  const handle = await open(filePath, LOCAL_READ_OPEN_FLAGS)
  try {
    const initialStats = await handle.stat()
    if (!initialStats.isFile()) {
      throw new Error('Local log tail target is not a file')
    }
    const fileIdentity = localLogFileIdentity(initialStats)
    if (
      fromByteOffset > initialStats.size ||
      (expectedIdentity !== undefined && expectedIdentity !== fileIdentity)
    ) {
      return {
        contentBase64: '',
        nextByteOffset: 0,
        fileSize: initialStats.size,
        fileIdentity,
        hasMore: initialStats.size > 0,
        reset: true
      }
    }

    const bytesToRead = Math.min(LOCAL_LOG_TAIL_CHUNK_BYTES, initialStats.size - fromByteOffset)
    const buffer = Buffer.allocUnsafe(bytesToRead)
    const { bytesRead } =
      bytesToRead > 0 ? await handle.read(buffer, 0, bytesToRead, fromByteOffset) : { bytesRead: 0 }
    const nextByteOffset = fromByteOffset + bytesRead
    const finalStats = await handle.stat()

    // Concurrent truncation must not leave the next append offset beyond EOF.
    if (nextByteOffset > finalStats.size) {
      return {
        contentBase64: '',
        nextByteOffset: 0,
        fileSize: finalStats.size,
        fileIdentity,
        hasMore: finalStats.size > 0,
        reset: true
      }
    }

    return {
      contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
      nextByteOffset,
      fileSize: finalStats.size,
      fileIdentity,
      hasMore: nextByteOffset < finalStats.size,
      reset: false
    }
  } finally {
    await handle.close()
  }
}
