import { constants, type Stats } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { isENOENT } from '../filesystem-path-containment'

export const NOT_A_REGULAR_FILE_MESSAGE = 'Not a regular file'

// O_NONBLOCK prevents FIFO-open hangs; regular files ignore it and Windows omits it.
export const LOCAL_READ_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)
const LOCAL_WRITE_PROBE_FLAGS = constants.O_WRONLY | (constants.O_NONBLOCK ?? 0)
const READ_CHUNK_BYTES = 1024 * 1024

export class FileTooLargeError extends Error {}

export function fileTooLargeError(size: number, limit: number): Error {
  return new FileTooLargeError(
    `File too large: ${(size / 1024 / 1024).toFixed(1)}MB exceeds ${limit / 1024 / 1024}MB limit`
  )
}

export async function openLocalRegularFile(
  filePath: string
): Promise<{ handle: FileHandle; stats: Stats }> {
  const handle = await open(filePath, LOCAL_READ_OPEN_FLAGS)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new Error(NOT_A_REGULAR_FILE_MESSAGE)
    }
    return { handle, stats }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Size from fstat is a hint; bounded chunks handle growth and false sizes without exceeding the cap. */
export async function readLocalFileBounded(
  handle: FileHandle,
  limit: number,
  expectedSize = 0
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  let nextChunkBytes = Math.max(0, Math.min(expectedSize, limit)) + 1
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(nextChunkBytes, limit + 1 - total))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
    if (bytesRead === 0) {
      return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)
    }
    chunks.push(chunk.subarray(0, bytesRead))
    total += bytesRead
    if (total > limit) {
      throw fileTooLargeError(total, limit)
    }
    // Confirm EOF after short reads without allocating another full-size chunk.
    nextChunkBytes = bytesRead < chunk.length ? 1 : READ_CHUNK_BYTES
  }
}

export async function readLocalFilePrefix(handle: FileHandle, bytes: number): Promise<Buffer> {
  const probe = Buffer.alloc(bytes)
  const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
  return probe.subarray(0, bytesRead)
}

export async function assertLocalWriteTargetIsRegularFile(filePath: string): Promise<void> {
  let handle: FileHandle
  try {
    handle = await open(filePath, LOCAL_WRITE_PROBE_FLAGS)
  } catch (error) {
    if (isENOENT(error)) {
      return
    }
    throw error
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(NOT_A_REGULAR_FILE_MESSAGE)
    }
  } finally {
    await handle.close()
  }
}
