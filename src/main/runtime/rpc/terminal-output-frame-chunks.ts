import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../shared/terminal-multiplex-flow-control'
import type { TerminalOutputSourceRange } from '../../../shared/terminal-output-source-range'
import { terminalStreamByteLength } from './terminal-stream-byte-length'

export type TerminalOutputMeta = {
  seq?: number
  rawLength?: number
  transformed?: boolean
  cwd?: string
  sourceRanges?: readonly TerminalOutputSourceRange[]
}

export type TerminalOutputFrameChunk = {
  bytes: Uint8Array<ArrayBufferLike>
  displayLength: number
  seq?: number
  opcode?: TerminalStreamOpcode
  sourceRanges?: readonly TerminalOutputSourceRange[]
}

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
  for (let start = 0; start < data.length; ) {
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
  meta?: TerminalOutputMeta
): Generator<TerminalOutputFrameChunk> {
  const rawLength = meta?.rawLength ?? data.length
  if (meta?.transformed || rawLength !== data.length) {
    yield {
      opcode: TerminalStreamOpcode.OutputSpan,
      bytes: encodeTerminalStreamJson({ data, rawLength, transformed: true }),
      displayLength: data.length,
      seq: meta?.seq,
      sourceRanges: meta?.sourceRanges
    }
    return
  }
  if (!exceedsTerminalStreamChunkBytes(data)) {
    yield {
      bytes: encodeTerminalStreamText(data),
      displayLength: data.length,
      seq: meta?.seq,
      sourceRanges: meta?.sourceRanges
    }
    return
  }
  const canPreserveChunkSeq = typeof meta?.seq === 'number' && rawLength === data.length
  // Unreachable past the OutputSpan branch above (rawLength === data.length there), but kept
  // as defence in depth: it is the only shape that can carry a seq the chunk offsets can't map.
  const shouldDelayFinalSeq = !canPreserveChunkSeq && typeof meta?.seq === 'number'
  const startSeq = canPreserveChunkSeq ? meta.seq! - rawLength : undefined
  let chunkStart = 0
  let chunkBytes = 0
  let delayedChunk: { text: string; seq?: number } | null = null

  // Why two offsets instead of an accumulator: the emitted text is always the contiguous
  // substring from chunkStart to end. Keep the legacy addition order for unsafe sequence values.
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
    // Why chunkBytes > 0: keeps a code point wider than the whole cap in its own frame
    // instead of splitting an empty one forever.
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
          seq: nextChunk.seq,
          sourceRanges: sliceTerminalOutputSourceRanges(
            meta?.sourceRanges,
            chunkStart - nextChunk.text.length,
            chunkStart
          )
        }
      }
    }
    chunkBytes += partBytes
    index += width
  }
  // A split always advances past its boundary, so the tail after the loop is never empty.
  const finalChunk = takeChunk(data.length)
  if (shouldDelayFinalSeq) {
    // Why: only the final frame can safely carry the high-water mark when rawLength can't map back to UTF-16 offsets.
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
    seq: finalChunk.seq,
    sourceRanges: sliceTerminalOutputSourceRanges(
      meta?.sourceRanges,
      data.length - finalChunk.text.length,
      data.length
    )
  }
}

export function sliceTerminalOutputSourceRanges(
  sourceRanges: readonly TerminalOutputSourceRange[] | undefined,
  displayStartOffset: number,
  displayEndOffset: number
): readonly TerminalOutputSourceRange[] | undefined {
  if (!sourceRanges || sourceRanges.length === 0) {
    return undefined
  }
  const baseDisplayStart = sourceRanges[0]!.displayStart
  const sliceStart = baseDisplayStart + displayStartOffset
  const sliceEnd = baseDisplayStart + displayEndOffset
  const selected: TerminalOutputSourceRange[] = []
  for (const range of sourceRanges) {
    const start = Math.max(sliceStart, range.displayStart)
    const end = Math.min(sliceEnd, range.displayEnd)
    if (end <= start) {
      continue
    }
    if (!range.splittable && (start !== range.displayStart || end !== range.displayEnd)) {
      throw new Error('terminal_source_range_indivisible_split')
    }
    const sourceStartSu = range.sourceStartSu + (start - range.displayStart)
    selected.push(
      Object.freeze({
        ...range,
        displayStart: start,
        displayEnd: end,
        sourceStartSu,
        sourceEndSu: sourceStartSu + (end - start),
        transform: Object.freeze({
          ...range.transform,
          rawLengthSu: end - start
        })
      })
    )
  }
  return Object.freeze(selected)
}
