import { describe, expect, it } from 'vitest'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../shared/terminal-multiplex-flow-control'
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
  it('preserves legacy addition rounding for unsafe sequence values', () => {
    const data = 'x'.repeat(TERMINAL_STREAM_CHUNK_BYTES + 1)
    const seq = 9_007_199_254_740_994
    const meta = seqPreservingMeta(data, seq)

    const frames = [...iterateTerminalOutputFrameChunks(data, meta)]
    expect(frames.at(-1)?.seq).toBe(9_007_199_254_740_992)
  })

  it('keeps every emitted frame within the wire cap and reassembles to the input', () => {
    const data = `${'a'.repeat(200 * 1024)}${SURROGATE_PAIR.repeat(4096)}${LONE_HIGH}`
    const frames = [...iterateTerminalOutputFrameChunks(data, seqPreservingMeta(data, 999_999))]
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

  it('emits exactly one frame when the payload fits the cap in bytes but not naively', () => {
    // 3-byte code points: 16384 code units = 49152 bytes = exactly the cap.
    const exact = '\u20ac'.repeat(TERMINAL_STREAM_CHUNK_BYTES / 3)
    expect(Buffer.byteLength(exact, 'utf8')).toBe(TERMINAL_STREAM_CHUNK_BYTES)
    expect([...iterateTerminalOutputFrameChunks(exact)]).toHaveLength(1)
    const overByOne = `${exact}a`
    expect([...iterateTerminalOutputFrameChunks(overByOne)].length).toBeGreaterThan(1)
  })
})
