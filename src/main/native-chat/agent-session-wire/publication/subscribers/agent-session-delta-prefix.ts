// Byte-bounded streamed text: appends in place, or truncates at a UTF-8 boundary with a marker.

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
    // Append in place to avoid copying the entire prefix for every token.
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

function truncateStreamPrefix(
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
  // A pair split across chunks is written whole, so a valid character never becomes two U+FFFD.
  let carry = ''
  for (let i = 0; i <= chunks.length; i += 1) {
    if (end === buffer.length) {
      return end
    }
    if (i === chunks.length) {
      return carry ? writePairedDelta(buffer, end, carry, delta) : end + writeAt(buffer, end, delta)
    }
    let piece = carry + chunks[i]
    carry = ''
    const last = piece.charCodeAt(piece.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
      carry = piece.slice(-1)
      piece = piece.slice(0, -1)
    }
    const written = buffer.write(piece, end, buffer.length - end, 'utf8')
    end += written
    if (written < Buffer.byteLength(piece, 'utf8')) {
      return end
    }
  }
  return end
}

function writeAt(buffer: Buffer, end: number, text: string): number {
  return buffer.write(text, end, buffer.length - end, 'utf8')
}

/** Writes the carried high surrogate with only the delta's first unit when that unit completes it,
 *  so the delta isn't copied. */
function writePairedDelta(buffer: Buffer, end: number, carry: string, delta: string): number {
  const first = delta.charCodeAt(0)
  const pairs = first >= 0xdc00 && first <= 0xdfff
  const pair = pairs ? carry + delta.slice(0, 1) : carry
  const written = writeAt(buffer, end, pair)
  return written < Buffer.byteLength(pair, 'utf8')
    ? end + written
    : end + written + writeAt(buffer, end + written, pairs ? delta.slice(1) : delta)
}
