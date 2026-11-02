import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../shared/terminal-multiplex-flow-control'
import { terminalStreamByteLength } from './terminal-stream-byte-length'

export type TerminalOutputMeta = {
  seq?: number
  rawLength?: number
  transformed?: boolean
  cwd?: string
}

export type TerminalOutputFrameChunk = {
  bytes: Uint8Array<ArrayBufferLike>
  displayLength: number
  seq?: number
  opcode?: TerminalStreamOpcode
  replayedQuery?: { seq: number; data: string }
  replayedEscapeTail?: true
}

/** `span` only for subscribers that decode OutputSpan (the multiplex); `text` is the opcode-1 encoding every client reads. */
export type TerminalOutputFrameEncoding = 'span' | 'text'

export const TERMINAL_STREAM_BYTE_PROBE_CODE_UNITS = 8 * 1024
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3

export function exceedsTerminalStreamChunkBytes(data: string): boolean {
  if (data.length > TERMINAL_STREAM_CHUNK_BYTES) {
    return true
  }
  if (data.length * MAX_UTF8_BYTES_PER_CODE_UNIT <= TERMINAL_STREAM_CHUNK_BYTES) {
    return false
  }
  let byteLength = 0
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + TERMINAL_STREAM_BYTE_PROBE_CODE_UNITS, data.length)
    const high = data.charCodeAt(end - 1)
    const low = data.charCodeAt(end)
    if (end < data.length && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      end -= 1
    }
    byteLength += terminalStreamByteLength(data.slice(start, end))
    if (byteLength > TERMINAL_STREAM_CHUNK_BYTES) {
      return true
    }
    start = end
  }
  return false
}

export function* iterateTerminalOutputFrameChunks(
  data: string,
  meta: TerminalOutputMeta | undefined,
  encoding: TerminalOutputFrameEncoding
): Generator<TerminalOutputFrameChunk> {
  const rawLength = meta?.rawLength ?? data.length
  const isSpan = meta?.transformed === true || rawLength !== data.length
  if (isSpan && encoding === 'span') {
    yield {
      opcode: TerminalStreamOpcode.OutputSpan,
      bytes: encodeTerminalStreamJson({ data, rawLength, transformed: true }),
      displayLength: data.length,
      seq: meta?.seq
    }
    return
  }
  if (isSpan && !data) {
    // Why: a fully stripped span has no text, and a text frame has no field for its raw length.
    return
  }
  if (!exceedsTerminalStreamChunkBytes(data)) {
    yield {
      bytes: encodeTerminalStreamText(data),
      displayLength: data.length,
      seq: meta?.seq
    }
    return
  }
  const canPreserveChunkSeq = typeof meta?.seq === 'number' && !isSpan
  // A span sent as text: chunk offsets can't map back to its raw sequence.
  const shouldDelayFinalSeq = !canPreserveChunkSeq && typeof meta?.seq === 'number'
  const startSeq = canPreserveChunkSeq ? meta.seq! - rawLength : undefined
  let chunkStart = 0
  let chunkBytes = 0
  let delayedChunk: { text: string; seq?: number } | null = null

  // Emit contiguous substrings; retain legacy addition order for unsafe sequence values.
  const takeChunk = (end: number): { text: string; seq?: number } => {
    const text = data.slice(chunkStart, end)
    const current = {
      text,
      seq: canPreserveChunkSeq ? startSeq! + chunkStart + text.length : undefined
    }
    chunkStart = end
    chunkBytes = 0
    return current
  }

  let index = 0
  while (index < data.length) {
    const code = data.charCodeAt(index)
    let width = 1
    let partBytes = 3
    if (code < 0x80) {
      partBytes = 1
    } else if (code < 0x800) {
      partBytes = 2
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      // Past the end charCodeAt is NaN, which masks to 0 — a trailing lone surrogate stays 3 bytes.
      (data.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      partBytes = 4
      width = 2
    }
    // A code point wider than the cap must occupy one frame; splitting an empty chunk would loop forever.
    if (chunkBytes > 0 && chunkBytes + partBytes > TERMINAL_STREAM_CHUNK_BYTES) {
      const nextChunk = takeChunk(index)
      if (shouldDelayFinalSeq) {
        if (delayedChunk) {
          yield {
            bytes: encodeTerminalStreamText(delayedChunk.text),
            displayLength: delayedChunk.text.length
          }
        }
        delayedChunk = nextChunk
      } else {
        yield {
          bytes: encodeTerminalStreamText(nextChunk.text),
          displayLength: nextChunk.text.length,
          seq: nextChunk.seq
        }
      }
    }
    chunkBytes += partBytes
    index += width
  }
  // A split always advances past its boundary, so the tail after the loop is never empty.
  const finalChunk = takeChunk(data.length)
  if (shouldDelayFinalSeq) {
    // Unmappable raw lengths may carry high-water only on the final frame.
    if (delayedChunk) {
      yield {
        bytes: encodeTerminalStreamText(delayedChunk.text),
        displayLength: delayedChunk.text.length
      }
    }
    yield {
      bytes: encodeTerminalStreamText(finalChunk.text),
      displayLength: finalChunk.text.length,
      seq: meta.seq
    }
    return
  }
  yield {
    bytes: encodeTerminalStreamText(finalChunk.text),
    displayLength: finalChunk.text.length,
    seq: finalChunk.seq
  }
}
