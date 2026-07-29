const JPEG_START = Buffer.from([0xff, 0xd8])
const JPEG_END = Buffer.from([0xff, 0xd9])
const DEFAULT_MAX_PENDING_BYTES = 2 * 1024 * 1024

export type MjpegFrameParseResult = {
  frames: Buffer<ArrayBufferLike>[]
  pending: Buffer<ArrayBufferLike>
}

function trimPendingBuffer(
  buffer: Buffer<ArrayBufferLike>,
  maxBytes: number
): Buffer<ArrayBufferLike> {
  if (buffer.length <= maxBytes) {
    return Buffer.from(buffer)
  }
  return Buffer.from(buffer.subarray(buffer.length - maxBytes))
}

export function extractJpegFrames(
  pending: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES
): MjpegFrameParseResult {
  // Why: when there are no leftover bytes the chunk already holds whole frames,
  // so read it directly instead of copying — frames below are views consumed
  // synchronously (the IPC layer copies into a transferable ArrayBuffer), and
  // any retained `pending` is copied out via trimPendingBuffer, so no chunk
  // memory is held across calls. At ~30fps this avoids a full-frame copy/frame.
  let cursor = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
  const frames: Buffer[] = []

  while (cursor.length > 0) {
    const frameStart = cursor.indexOf(JPEG_START)
    if (frameStart < 0) {
      const keepLastByte = cursor.at(-1) === 0xff
      return { frames, pending: keepLastByte ? Buffer.from([0xff]) : Buffer.alloc(0) }
    }
    if (frameStart > 0) {
      cursor = cursor.subarray(frameStart)
    }

    const frameEnd = cursor.indexOf(JPEG_END, JPEG_START.length)
    if (frameEnd < 0) {
      return { frames, pending: trimPendingBuffer(cursor, maxPendingBytes) }
    }

    const nextOffset = frameEnd + JPEG_END.length
    // A view, not a copy: the caller consumes each frame synchronously before
    // the next chunk arrives, and `cursor` is only ever re-sliced (never mutated).
    frames.push(cursor.subarray(0, nextOffset))
    cursor = cursor.subarray(nextOffset)
  }

  return { frames, pending: Buffer.alloc(0) }
}
