export const TAIL_CHUNK_BYTES = 64 * 1024
export type TranscriptTailChunkRead = (position: number, length: number) => Promise<Buffer>

/**
 * The byte at `position`, or null when the file shrank below it between the
 * caller's stat and this read (allocUnsafe would otherwise hand back garbage).
 */
export async function readTranscriptByteAt(
  read: TranscriptTailChunkRead,
  position: number,
  signal?: AbortSignal
): Promise<number | null> {
  signal?.throwIfAborted()
  const bytes = await read(position, 1)
  signal?.throwIfAborted()
  return bytes.length === 1 ? (bytes[0] ?? null) : null
}

/** End offset (exclusive) of the last newline-terminated line at or before `end`. */
export async function findLastCompleteLineEnd(
  read: TranscriptTailChunkRead,
  end: number,
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted()
  const lastByte = await readTranscriptByteAt(read, end - 1, signal)
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
    const buffer = await read(start, cursor - start)
    signal?.throwIfAborted()
    if (buffer.length < cursor - start) {
      // File shrank mid-walk: any boundary computed from stale offsets is wrong.
      return 0
    }
    const newline = buffer.lastIndexOf(0x0a)
    if (newline !== -1) {
      return start + newline + 1
    }
    cursor = start
  }
  return 0
}
