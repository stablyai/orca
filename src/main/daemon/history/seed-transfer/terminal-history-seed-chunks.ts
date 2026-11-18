import { createHash } from 'node:crypto'

export const TERMINAL_HISTORY_SEED_CHUNK_CODE_UNITS = 512 * 1024
export const TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS = 1024 * 1024

export type TerminalHistorySeedMetrics = {
  chunkCount: number
  codeUnits: number
  sha256: string
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

export function* iterateTerminalHistorySeedChunks(segments: readonly string[]): Generator<string> {
  let trailingHighSurrogate = ''

  for (const segment of segments) {
    let offset = 0
    if (trailingHighSurrogate) {
      if (segment.length > 0 && isLowSurrogate(segment.charCodeAt(0))) {
        yield trailingHighSurrogate + segment[0]
        offset = 1
      } else {
        yield trailingHighSurrogate
      }
      trailingHighSurrogate = ''
    }

    while (offset < segment.length) {
      let end = Math.min(segment.length, offset + TERMINAL_HISTORY_SEED_CHUNK_CODE_UNITS)
      if (
        end < segment.length &&
        isHighSurrogate(segment.charCodeAt(end - 1)) &&
        isLowSurrogate(segment.charCodeAt(end))
      ) {
        end -= 1
      }
      if (end === segment.length && isHighSurrogate(segment.charCodeAt(end - 1))) {
        trailingHighSurrogate = segment[end - 1]
        end -= 1
      }
      if (end > offset) {
        yield segment.slice(offset, end)
      }
      offset = Math.max(end, offset + (end === offset ? 1 : 0))
    }
  }

  if (trailingHighSurrogate) {
    yield trailingHighSurrogate
  }
}

export function measureTerminalHistorySeed(
  segments: readonly string[]
): TerminalHistorySeedMetrics {
  const hash = createHash('sha256')
  let chunkCount = 0
  let codeUnits = 0

  for (const chunk of iterateTerminalHistorySeedChunks(segments)) {
    hash.update(Buffer.from(chunk, 'utf16le'))
    chunkCount += 1
    codeUnits += chunk.length
  }

  return { chunkCount, codeUnits, sha256: hash.digest('hex') }
}
