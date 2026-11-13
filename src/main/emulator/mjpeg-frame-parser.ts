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
  // Reuse the input when possible: frames are consumed synchronously and retained pending bytes are copied.
  let cursor = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
  const frames: Buffer[] = []

  while (cursor.length > 0) {
    const frameStart = cursor.indexOf(JPEG_START)
    if (frameStart === -1) {
      const keepLastByte = cursor.at(-1) === 0xff
      return { frames, pending: keepLastByte ? Buffer.from([0xff]) : Buffer.alloc(0) }
    }
    if (frameStart > 0) {
      cursor = cursor.subarray(frameStart)
    }

    const frameEnd = cursor.indexOf(JPEG_END, JPEG_START.length)
    if (frameEnd === -1) {
      return { frames, pending: trimPendingBuffer(cursor, maxPendingBytes) }
    }

    const nextOffset = frameEnd + JPEG_END.length
    frames.push(cursor.subarray(0, nextOffset))
    cursor = cursor.subarray(nextOffset)
  }

  return { frames, pending: Buffer.alloc(0) }
}

// Why: a frame spans many socket chunks; re-joining the growing tail on every chunk is
// quadratic in chunks per frame, so hold chunks until one could complete the frame.
export class MjpegFrameAccumulator {
  private parts: Buffer<ArrayBufferLike>[] = []
  private bytes = 0

  constructor(private readonly maxPendingBytes = DEFAULT_MAX_PENDING_BYTES) {}

  push(chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike>[] {
    if (chunk.length === 0) {
      return []
    }
    const head = this.parts[0]
    if (
      head?.[0] === 0xff &&
      head[1] === 0xd8 &&
      !(this.parts.at(-1)?.at(-1) === 0xff && chunk[0] === 0xd9) &&
      !chunk.includes(JPEG_END) &&
      this.bytes + chunk.length <= this.maxPendingBytes
    ) {
      // Copied like extractJpegFrames' pending, so no caller chunk memory is retained.
      this.parts.push(Buffer.from(chunk))
      this.bytes += chunk.length
      return []
    }
    const pending = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.bytes)
    const result = extractJpegFrames(pending, chunk, this.maxPendingBytes)
    this.parts = result.pending.length > 0 ? [result.pending] : []
    this.bytes = result.pending.length
    return result.frames
  }

  reset(): void {
    this.parts = []
    this.bytes = 0
  }
}
