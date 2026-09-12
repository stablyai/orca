import { wslGatedRead } from './wsl-transcript-fs-access'
import type { TranscriptFileHandle } from './wsl-transcript-fs-access'

export const TAIL_CHUNK_BYTES = 64 * 1024

/**
 * The byte at `position`, or null when the file shrank below it between the
 * caller's stat and this read (allocUnsafe would otherwise hand back garbage).
 */
export async function readTranscriptByteAt(
  handle: TranscriptFileHandle,
  filePath: string,
  position: number,
  signal?: AbortSignal
): Promise<number | null> {
  const byte = Buffer.allocUnsafe(1)
  const { bytesRead } = await wslGatedRead(handle, filePath, byte, 0, 1, position, 'exact', signal)
  signal?.throwIfAborted()
  return bytesRead === 1 ? byte[0] : null
}

/** End offset (exclusive) of the last newline-terminated line at or before `end`. */
export async function findLastCompleteLineEnd(
  handle: TranscriptFileHandle,
  filePath: string,
  end: number,
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted()
  const lastByte = await readTranscriptByteAt(handle, filePath, end - 1, signal)
  if (lastByte === null) {
    // File shrank between stat and probe.
    return 0
  }
  if (lastByte === 0x0a) {
    return end
  }
  let cursor = end
  while (cursor > 0) {
    signal?.throwIfAborted()
    const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
    const buffer = Buffer.allocUnsafe(cursor - start)
    const { bytesRead } = await wslGatedRead(
      handle,
      filePath,
      buffer,
      0,
      buffer.length,
      start,
      'exact',
      signal
    )
    signal?.throwIfAborted()
    if (bytesRead < buffer.length) {
      // File shrank mid-walk: any boundary computed from stale offsets is wrong.
      return 0
    }
    const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (newline !== -1) {
      return start + newline + 1
    }
    cursor = start
  }
  return 0
}
