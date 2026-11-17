import type { AgentSessionTextAppendSource } from '../../../../../shared/agent-session/view/live-read/agent-session-text-append-source'
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
  for (const chunk of chunks) {
    if (end === buffer.length) {
      return end
    }
    const written = buffer.write(chunk, end, buffer.length - end, 'utf8')
    end += written
    // Independent chunk encoding preserves split-surrogate replacement.
    if (written < Buffer.byteLength(chunk, 'utf8')) {
      return end
    }
  }
  return end + buffer.write(delta, end, buffer.length - end, 'utf8')
}

/** Read only chunks intersecting a suffix, even when a subscriber skipped live windows. */
export function streamedTextAppendSource(
  identity: object,
  chunks: string[],
  offsets: number[],
  length: number,
  jsonBytes?: number
): AgentSessionTextAppendSource {
  const end = chunks.length
  return {
    identity,
    length,
    jsonBytes,
    suffix: (from) => {
      let low = 0
      let high = end
      while (low < high) {
        const middle = (low + high) >>> 1
        if (offsets[middle]! <= from) {
          low = middle + 1
        } else {
          high = middle
        }
      }
      const at = Math.max(0, low - 1)
      return from === length
        ? ''
        : (chunks[at]!.slice(from - offsets[at]!) + chunks.slice(at + 1, end).join('')).slice(
            0,
            length - from
          )
    }
  }
}

/** JSON escapes control characters and lone surrogates; a split pair replaces two escapes. */
export function appendedJsonTextBytes(lastUnit: number, delta: string): number {
  const paired =
    lastUnit >= 0xd800 &&
    lastUnit <= 0xdbff &&
    delta.charCodeAt(0) >= 0xdc00 &&
    delta.charCodeAt(0) <= 0xdfff
  return Buffer.byteLength(JSON.stringify(delta), 'utf8') - 2 - (paired ? 8 : 0)
}

/** Keep append provenance and exact JSON sizing without revisiting retained text. */
export function trackStreamedTextAppend(
  stream: {
    identity: object
    offsets: number[]
    joinedLength: number
    joinedText: string
    jsonBytes: number
    lastUnit: number
    textLength: number
  },
  next: { chunks: string[]; truncated: boolean },
  delta: string,
  chunkCount: number
): void {
  if (next.truncated) {
    stream.identity = {}
    stream.offsets = [0]
    stream.joinedLength = 0
    stream.joinedText = ''
    stream.jsonBytes = Buffer.byteLength(JSON.stringify(next.chunks[0] ?? ''), 'utf8') - 2
  } else {
    stream.jsonBytes += appendedJsonTextBytes(stream.lastUnit, delta)
    // Bound chunk metadata even for single-character provider deltas.
    const tail = chunkCount - 1
    if (tail >= 0 && next.chunks[tail]!.length < 4096) {
      next.chunks[tail] += next.chunks.pop()!
    } else {
      stream.offsets.push(stream.textLength)
    }
  }
  stream.lastUnit = next.chunks.at(-1)?.charCodeAt(next.chunks.at(-1)!.length - 1) ?? Number.NaN
}
