export const AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER = '\n[Orca: streamed output truncated]'

export function appendWithinUtf8ByteLimit(
  current: string[],
  currentBytes: number,
  delta: string,
  deltaBytes: number,
  maxBytes: number
): { chunks: string[]; retainedBytes: number; truncated: boolean } {
  const available = Math.max(0, maxBytes - currentBytes)
  if (deltaBytes <= available) {
    // The caller owns the per-stream array; append in place so each token is
    // amortized O(1) instead of copying the complete prefix on every delta.
    if (delta.length > 0) {
      current.push(delta)
    }
    return {
      chunks: current,
      retainedBytes: currentBytes + deltaBytes,
      truncated: false
    }
  }
  return truncateStreamPrefix(current, delta, maxBytes)
}

export function truncateStreamPrefix(
  current: string[],
  delta: string,
  maxBytes: number
): { chunks: string[]; retainedBytes: number; truncated: boolean } {
  const marker = Buffer.from(AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER, 'utf8')
  const headBytes = Math.max(0, maxBytes - marker.byteLength)
  const boundedHead = Number.isSafeInteger(maxBytes) && maxBytes >= 0
  const combined = boundedHead
    ? Buffer.allocUnsafe(headBytes)
    : Buffer.concat([
        ...current.map((chunk) => Buffer.from(chunk, 'utf8')),
        Buffer.from(delta, 'utf8')
      ])
  let end = boundedHead
    ? writeStreamPrefix(combined, current, delta)
    : Math.min(combined.byteLength, headBytes)
  if (!boundedHead) {
    while (end > 0 && (combined[end] & 0b1100_0000) === 0b1000_0000) {
      end -= 1
    }
  }
  const visibleMarker = marker.subarray(0, Math.min(marker.byteLength, maxBytes - end))
  const text = combined.subarray(0, end).toString('utf8') + visibleMarker.toString('utf8')
  return {
    chunks: text ? [text] : [],
    retainedBytes: Buffer.byteLength(text, 'utf8'),
    truncated: true
  }
}

function writeStreamPrefix(buffer: Buffer, chunks: string[], delta: string): number {
  let end = 0
  for (const chunk of chunks) {
    if (end === buffer.length) {
      return end
    }
    const written = buffer.write(chunk, end, buffer.length - end, 'utf8')
    end += written
    // Encode each chunk independently to preserve split-surrogate replacement.
    if (written < Buffer.byteLength(chunk, 'utf8')) {
      return end
    }
  }
  return end + buffer.write(delta, end, buffer.length - end, 'utf8')
}
