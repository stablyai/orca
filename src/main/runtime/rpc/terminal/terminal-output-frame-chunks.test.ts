import { describe, expect, it } from 'vitest'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import {
  iterateTerminalOutputFrameChunks,
  type TerminalOutputMeta
} from './terminal-output-frame-chunks'

const SURROGATE_PAIR = '\u{1f600}'
const LONE_HIGH = '\ud83d'

function seqPreservingMeta(data: string, seq: number): TerminalOutputMeta {
  return { seq, rawLength: data.length }
}

describe('terminal output frame chunks', () => {
  it('keeps every emitted frame within the wire cap and reassembles to the input', () => {
    const data = `${'a'.repeat(TERMINAL_STREAM_CHUNK_BYTES - 3)}${SURROGATE_PAIR}${'a'.repeat(200 * 1024)}${SURROGATE_PAIR.repeat(4096)}${LONE_HIGH}`
    const frames = [
      ...iterateTerminalOutputFrameChunks(data, seqPreservingMeta(data, 999_999), 'span')
    ]
    expect(frames.length).toBeGreaterThan(4)
    for (const frame of frames) {
      expect(frame.bytes.byteLength).toBeLessThanOrEqual(TERMINAL_STREAM_CHUNK_BYTES)
    }
    expect(Buffer.concat(frames.map((frame) => Buffer.from(frame.bytes))).toString('utf8')).toBe(
      Buffer.from(new TextEncoder().encode(data)).toString('utf8')
    )
    // Seqs must be strictly increasing and end at the meta high-water mark.
    const seqs = frames.map((frame) => frame.seq!)
    expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)).toBe(true)
    expect(seqs.at(-1)).toBe(999_999)
  })
})
