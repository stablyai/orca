import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../shared/terminal-multiplex-flow-control'

export type TerminalOutputMeta = {
  seq?: number
  rawLength?: number
  transformed?: boolean
  cwd?: string
}

export type TerminalOutputFrameChunk = {
  bytes: Uint8Array<ArrayBufferLike>
  seq?: number
  opcode?: TerminalStreamOpcode
}

// Why: UTF-8 length is never below UTF-16 length, so a code-unit count over the cap already proves the byte count is.
function exceedsTerminalStreamChunkBytes(data: string): boolean {
  return (
    data.length > TERMINAL_STREAM_CHUNK_BYTES ||
    Buffer.byteLength(data, 'utf8') > TERMINAL_STREAM_CHUNK_BYTES
  )
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
      seq: meta?.seq
    }
    return
  }
  if (!exceedsTerminalStreamChunkBytes(data)) {
    yield { bytes: encodeTerminalStreamText(data), seq: meta?.seq }
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
          yield { bytes: encodeTerminalStreamText(delayedChunk.text) }
        }
        delayedChunk = nextChunk
      } else {
        yield { bytes: encodeTerminalStreamText(nextChunk.text), seq: nextChunk.seq }
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
      yield { bytes: encodeTerminalStreamText(delayedChunk.text) }
    }
    yield { bytes: encodeTerminalStreamText(finalChunk.text), seq: meta.seq }
    return
  }
  yield { bytes: encodeTerminalStreamText(finalChunk.text), seq: finalChunk.seq }
}
