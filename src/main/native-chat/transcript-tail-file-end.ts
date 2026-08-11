import type { FileHandle } from 'node:fs/promises'

export const TAIL_CHUNK_BYTES = 64 * 1024

export async function findLastCompleteLineEnd(
  handle: FileHandle,
  end: number,
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted()
  const lastByte = Buffer.allocUnsafe(1)
  await handle.read(lastByte, 0, 1, end - 1)
  signal?.throwIfAborted()
  if (lastByte[0] === 0x0a) {
    return end
  }
  let cursor = end
  while (cursor > 0) {
    signal?.throwIfAborted()
    const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
    const buffer = Buffer.allocUnsafe(cursor - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    signal?.throwIfAborted()
    const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (newline !== -1) {
      return start + newline + 1
    }
    cursor = start
  }
  return 0
}
