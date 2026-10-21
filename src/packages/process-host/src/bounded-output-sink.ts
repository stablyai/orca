import { Buffer } from 'node:buffer'
import { GrowingByteBuffer } from './growing-byte-buffer'

/**
 * Collects output up to a cap, so a chatty child cannot grow the heap.
 *
 * Accepts strings as well as buffers: a stream someone called `setEncoding` on
 * emits strings, and concatenating those as buffers throws inside a `data`
 * handler, where the rejection has nowhere to go and the caller just hangs.
 */
export function createOutputSink(
  maxBytes: number,
  outputCapture: 'head' | 'tail' = 'head'
): {
  write: (chunk: Buffer | string) => void
  buffer: () => Buffer
  text: () => string
  truncated: () => boolean
} {
  const chunks: Buffer[] = []
  const tail = outputCapture === 'tail' ? new GrowingByteBuffer() : undefined
  let bytes = 0
  const buffer = (): Buffer =>
    tail
      ? tail.toBuffer()
      : chunks.length === 0
        ? Buffer.alloc(0)
        : chunks.length === 1
          ? chunks[0]
          : Buffer.concat(chunks)
  return {
    buffer,
    write(raw) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      const remaining = maxBytes - bytes
      bytes += chunk.length
      if (tail) {
        tail.appendRetainedSuffix(chunk, maxBytes)
        return
      }
      if (remaining <= 0) {
        return
      }
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
    },
    text: () => tail?.toString() ?? buffer().toString('utf8'),
    // Why: callers that parse the output need to tell a short answer from a
    // clipped one -- truncated JSON or JSONL parses as a smaller valid result.
    truncated: () => bytes > maxBytes
  }
}
