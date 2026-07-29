import { describe, expect, it } from 'vitest'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../shared/terminal-multiplex-flow-control'
import { measureClipboardTextByteLength } from '../../../shared/clipboard-text'
import {
  TERMINAL_STREAM_BYTE_PROBE_CODE_UNITS,
  exceedsTerminalStreamChunkBytes,
  iterateTerminalOutputFrameChunks,
  type TerminalOutputFrameChunk,
  type TerminalOutputMeta
} from './terminal-output-frame-chunks'

// Byte-for-byte reference: the pre-optimization implementation, copied verbatim.
// It accumulates `chunk += part` over `for (const part of data)` and measures each
// code point through the shared clipboard measurer.
function legacyByteLength(data: string): number {
  return measureClipboardTextByteLength(data).byteLength
}

function legacyByteLengthExceeds(data: string, maxBytes: number): boolean {
  return measureClipboardTextByteLength(data, { stopAfterBytes: maxBytes }).exceededLimit
}

function expectGateEquivalent(data: string, label: string): void {
  expect({ label, result: exceedsTerminalStreamChunkBytes(data) }).toEqual({
    label,
    result: legacyByteLengthExceeds(data, TERMINAL_STREAM_CHUNK_BYTES)
  })
}

function makeExactByteLength(unit: string, byteLength: number): string {
  const unitBytes = Buffer.byteLength(unit, 'utf8')
  const repeats = Math.floor(byteLength / unitBytes)
  return unit.repeat(repeats) + 'a'.repeat(byteLength - repeats * unitBytes)
}

function* legacyIterateTerminalOutputFrameChunks(
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
  if (!legacyByteLengthExceeds(data, TERMINAL_STREAM_CHUNK_BYTES)) {
    yield { bytes: encodeTerminalStreamText(data), seq: meta?.seq }
    return
  }
  const canPreserveChunkSeq = typeof meta?.seq === 'number' && rawLength === data.length
  const shouldDelayFinalSeq = !canPreserveChunkSeq && typeof meta?.seq === 'number'
  const startSeq = canPreserveChunkSeq ? meta.seq! - rawLength : undefined
  let chunk = ''
  let chunkBytes = 0
  let chunkStartOffset = 0
  let offset = 0
  let delayedChunk: { text: string; seq?: number } | null = null

  const takeChunk = (): { text: string; seq?: number } | null => {
    if (!chunk) {
      return null
    }
    const chunkSeq = canPreserveChunkSeq ? startSeq! + chunkStartOffset + chunk.length : undefined
    const current = { text: chunk, seq: chunkSeq }
    chunk = ''
    chunkBytes = 0
    chunkStartOffset = offset
    return current
  }

  for (const part of data) {
    const partBytes = legacyByteLength(part)
    if (chunkBytes > 0 && chunkBytes + partBytes > TERMINAL_STREAM_CHUNK_BYTES) {
      const nextChunk = takeChunk()
      if (nextChunk) {
        if (shouldDelayFinalSeq) {
          if (delayedChunk) {
            yield { bytes: encodeTerminalStreamText(delayedChunk.text) }
          }
          delayedChunk = nextChunk
        } else {
          yield { bytes: encodeTerminalStreamText(nextChunk.text), seq: nextChunk.seq }
        }
      }
    }
    chunk += part
    chunkBytes += partBytes
    offset += part.length
  }
  const finalChunk = takeChunk()
  if (shouldDelayFinalSeq) {
    if (finalChunk) {
      if (delayedChunk) {
        yield { bytes: encodeTerminalStreamText(delayedChunk.text) }
      }
      delayedChunk = finalChunk
    }
    if (delayedChunk) {
      yield { bytes: encodeTerminalStreamText(delayedChunk.text), seq: meta.seq }
    }
    return
  }
  if (finalChunk) {
    yield { bytes: encodeTerminalStreamText(finalChunk.text), seq: finalChunk.seq }
  }
}

type FrameShape = { base64: string; seq: number | 'undefined'; opcode: number | 'undefined' }

function describeFrames(frames: Iterable<TerminalOutputFrameChunk>): FrameShape[] {
  const out: FrameShape[] = []
  for (const frame of frames) {
    out.push({
      base64: Buffer.from(frame.bytes).toString('base64'),
      seq: frame.seq ?? 'undefined',
      opcode: frame.opcode ?? 'undefined'
    })
  }
  return out
}

function expectEquivalent(data: string, meta: TerminalOutputMeta | undefined, label: string): void {
  const legacy = describeFrames(legacyIterateTerminalOutputFrameChunks(data, meta))
  const next = describeFrames(iterateTerminalOutputFrameChunks(data, meta))
  expect(next, label).toEqual(legacy)
}

const SURROGATE_PAIR = '\u{1f600}'
const LONE_HIGH = '\ud83d'
const LONE_LOW = '\ude00'
// Extremes of both surrogate ranges: U+10000 (D800 DC00) and U+10FFFF (DBFF DFFF).
const FIRST_ASTRAL = '\u{10000}'
const LAST_ASTRAL = '\u{10ffff}'
const SURROGATE_EDGES = [
  '\ud800',
  '\udbff',
  '\udc00',
  '\udfff',
  FIRST_ASTRAL,
  LAST_ASTRAL,
  '\udbff\udbff',
  '\ud800\udbff',
  '\udfff\udc00'
]

// Meta shapes exercised against every fixture: no meta, seq-preserved (rawLength ===
// data.length), the delayed-final-seq path (rawLength !== data.length -> OutputSpan),
// transformed, and cwd-only.
function metaShapesFor(data: string): { label: string; meta: TerminalOutputMeta | undefined }[] {
  return [
    { label: 'no-meta', meta: undefined },
    { label: 'seq-only', meta: { seq: 5_000_000 } },
    { label: 'seq+rawLength=len', meta: { seq: 9_000, rawLength: data.length } },
    { label: 'seq+rawLength!=len', meta: { seq: 9_000, rawLength: data.length + 7 } },
    { label: 'rawLength!=len only', meta: { rawLength: data.length + 3 } },
    { label: 'transformed', meta: { seq: 42, rawLength: data.length, transformed: true } },
    { label: 'cwd-only', meta: { cwd: '/home/dev/orca' } },
    { label: 'seq=0', meta: { seq: 0, rawLength: data.length } }
  ]
}

function sweepAll(data: string, label: string): void {
  for (const shape of metaShapesFor(data)) {
    expectEquivalent(data, shape.meta, `${label} [${shape.label}]`)
  }
}

// A fixture whose seq path is only observable when rawLength maps 1:1 to UTF-16
// offsets; forcing that shape is what makes the algebraic collapse testable.
function seqPreservingMeta(data: string, seq: number): TerminalOutputMeta {
  return { seq, rawLength: data.length }
}

function escapeUnits(value: string): string {
  const units: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    units.push(`U+${value.charCodeAt(index).toString(16).toUpperCase()}`)
  }
  return units.join(' ')
}

function repeatToLength(unit: string, codeUnits: number): string {
  let out = ''
  while (out.length < codeUnits) {
    out += unit
  }
  return out.slice(0, out.length - (out.length % unit.length))
}

// Deterministic PRNG so a fuzz failure is reproducible from the seed alone.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

const FUZZ_ALPHABET = [
  'a',
  'z',
  '\r',
  '\n',
  '\u00e9',
  '\u20ac',
  SURROGATE_PAIR,
  LONE_HIGH,
  LONE_LOW,
  '\u0000',
  '\u001b'
]

function randomText(random: () => number, parts: number): string {
  let out = ''
  for (let index = 0; index < parts; index += 1) {
    out += FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)]
  }
  return out
}

describe('iterateTerminalOutputFrameChunks equivalence with the pre-optimization loop', () => {
  it('matches the legacy gate at the byte cap ±3 for every UTF-8 shape', () => {
    for (const [label, unit] of [
      ['ascii', 'a'],
      ['two-byte', '\u00e9'],
      ['three-byte', '\u20ac'],
      ['astral', SURROGATE_PAIR],
      ['lone-high', LONE_HIGH],
      ['lone-low', LONE_LOW],
      ['reversed-surrogates', `${LONE_LOW}${LONE_HIGH}a`]
    ] as const) {
      for (let delta = -3; delta <= 3; delta += 1) {
        const byteLength = TERMINAL_STREAM_CHUNK_BYTES + delta
        const data = makeExactByteLength(unit, byteLength)
        expect(Buffer.byteLength(data, 'utf8')).toBe(byteLength)
        expectGateEquivalent(data, `${label} delta=${delta}`)
      }
    }
  })

  it('matches when probe boundaries bisect or surround surrogate pairs', () => {
    const probe = TERMINAL_STREAM_BYTE_PROBE_CODE_UNITS
    for (const offset of [-2, -1, 0, 1, 2]) {
      const pairStart = probe + offset
      const prefix = 'a'.repeat(pairStart)
      const suffix = '\u20ac'.repeat(12_000)
      for (const middle of [SURROGATE_PAIR, LONE_HIGH, LONE_LOW, LONE_LOW + LONE_HIGH]) {
        const data = prefix + middle + suffix
        expectGateEquivalent(data, `probe offset=${offset} middle=${escapeUnits(middle)}`)
        expectEquivalent(data, undefined, `probe frames offset=${offset}`)
      }
    }
  })

  it('stops correctly when late wide text crosses the cap', () => {
    const asciiPrefix = 'a'.repeat(16_000)
    for (const wide of ['\u00e9', '\u20ac', SURROGATE_PAIR, LONE_HIGH]) {
      for (const wideParts of [8_000, 12_000, 16_000]) {
        const data = asciiPrefix + wide.repeat(wideParts)
        expectGateEquivalent(data, `late-wide ${escapeUnits(wide)} parts=${wideParts}`)
        expectEquivalent(data, undefined, `late-wide frames ${escapeUnits(wide)}`)
      }
    }
  })

  it('matches on the small/no-chunking sizes', () => {
    for (const size of [0, 1, 2, 3, 7, 64, 1024, TERMINAL_STREAM_CHUNK_BYTES - 1]) {
      sweepAll('a'.repeat(size), `ascii ${size}`)
    }
  })

  it('matches across 1B..200KiB ASCII payloads', () => {
    for (const size of [
      1,
      100,
      TERMINAL_STREAM_CHUNK_BYTES,
      TERMINAL_STREAM_CHUNK_BYTES + 1,
      TERMINAL_STREAM_CHUNK_BYTES * 2,
      TERMINAL_STREAM_CHUNK_BYTES * 3 + 17,
      100 * 1024,
      200 * 1024
    ]) {
      sweepAll('x'.repeat(size), `ascii ${size}`)
    }
  })

  it('preserves legacy addition rounding for unsafe sequence values', () => {
    const data = 'x'.repeat(TERMINAL_STREAM_CHUNK_BYTES + 1)
    const seq = 9_007_199_254_740_994
    const meta = seqPreservingMeta(data, seq)

    expectEquivalent(data, meta, 'unsafe seq rounding')
    const frames = [...iterateTerminalOutputFrameChunks(data, meta)]
    expect(frames.at(-1)?.seq).toBe(9_007_199_254_740_992)
  })

  it('matches on multi-byte-only payloads at every UTF-8 width', () => {
    // UTF-8 width boundaries: 1|2 at U+0080, 2|3 at U+0800, 3|4 at U+10000.
    for (const unit of [
      '\u00e9',
      '\u20ac',
      SURROGATE_PAIR,
      '\u0080',
      '\u07ff',
      '\u0800',
      '\uffff'
    ]) {
      for (const codeUnits of [
        TERMINAL_STREAM_CHUNK_BYTES / 2,
        TERMINAL_STREAM_CHUNK_BYTES,
        TERMINAL_STREAM_CHUNK_BYTES + 64,
        90 * 1024
      ]) {
        const data = repeatToLength(unit, codeUnits)
        sweepAll(data, `unit=${JSON.stringify(unit)} codeUnits=${codeUnits}`)
      }
    }
  })

  it('matches with lone surrogates, including a trailing lone high surrogate', () => {
    const filler = 'a'.repeat(TERMINAL_STREAM_CHUNK_BYTES + 5)
    for (const data of [
      LONE_HIGH,
      LONE_LOW,
      LONE_HIGH + LONE_HIGH,
      LONE_LOW + LONE_HIGH,
      filler + LONE_HIGH,
      filler + LONE_LOW,
      LONE_HIGH + filler,
      LONE_LOW + filler,
      filler + LONE_HIGH + filler,
      // Reversed pair: never a valid pair, so both halves must stay 3-byte replacements.
      filler + LONE_LOW + LONE_HIGH + filler,
      repeatToLength(LONE_HIGH, 60 * 1024),
      repeatToLength(LONE_LOW + LONE_HIGH, 60 * 1024)
    ]) {
      sweepAll(data, `lone-surrogate len=${data.length}`)
    }
  })

  it('matches at both ends of both surrogate ranges (U+D800..U+DBFF, U+DC00..U+DFFF)', () => {
    const filler = 'a'.repeat(TERMINAL_STREAM_CHUNK_BYTES + 5)
    for (const edge of SURROGATE_EDGES) {
      for (const data of [
        edge,
        filler + edge,
        edge + filler,
        filler + edge + filler,
        repeatToLength(edge, 40 * 1024)
      ]) {
        sweepAll(data, `surrogate-edge ${escapeUnits(edge)} len=${data.length}`)
      }
      // Land the split inside the edge sequence itself.
      for (let offset = -4; offset <= 4; offset += 1) {
        const data = `${'a'.repeat(TERMINAL_STREAM_CHUNK_BYTES + offset)}${edge}${'b'.repeat(8)}`
        expectEquivalent(data, undefined, `surrogate-edge ${escapeUnits(edge)} offset=${offset}`)
        expectEquivalent(
          data,
          seqPreservingMeta(data, 500_000 + data.length),
          `surrogate-edge ${escapeUnits(edge)} offset=${offset} seq`
        )
      }
    }
  })

  it('sweeps a chunk boundary across a surrogate pair at CHUNK-4..CHUNK+4', () => {
    for (let offset = -4; offset <= 4; offset += 1) {
      const prefixBytes = TERMINAL_STREAM_CHUNK_BYTES + offset
      const data = `${'a'.repeat(prefixBytes)}${SURROGATE_PAIR}${'b'.repeat(64)}`
      sweepAll(data, `pair boundary offset=${offset}`)
      expectEquivalent(
        data,
        seqPreservingMeta(data, 1_000_000 + data.length),
        `pair boundary offset=${offset} seq-preserved`
      )
    }
  })

  it('sweeps a chunk boundary across a multi-byte run at CHUNK-4..CHUNK+4', () => {
    for (let offset = -4; offset <= 4; offset += 1) {
      const prefixBytes = TERMINAL_STREAM_CHUNK_BYTES + offset
      // 3-byte run straddling the cap: the split point cannot land mid-code-point.
      const data = `${'a'.repeat(prefixBytes)}${'\u20ac'.repeat(32)}${'b'.repeat(16)}`
      sweepAll(data, `multibyte boundary offset=${offset}`)
    }
  })

  it('sweeps a chunk boundary across a lone surrogate at CHUNK-4..CHUNK+4', () => {
    for (let offset = -4; offset <= 4; offset += 1) {
      const prefixBytes = TERMINAL_STREAM_CHUNK_BYTES + offset
      for (const lone of [LONE_HIGH, LONE_LOW]) {
        const data = `${'a'.repeat(prefixBytes)}${lone}${'b'.repeat(64)}`
        sweepAll(data, `lone ${lone === LONE_HIGH ? 'high' : 'low'} boundary offset=${offset}`)
      }
      // Lone high surrogate as the very last code unit of the payload.
      const trailing = `${'a'.repeat(prefixBytes)}${LONE_HIGH}`
      sweepAll(trailing, `trailing lone high offset=${offset}`)
    }
  })

  it('sweeps 2-byte and 4-byte code points across a 1-code-unit window at the cap', () => {
    for (const unit of ['\u00e9', SURROGATE_PAIR]) {
      for (
        let pad = TERMINAL_STREAM_CHUNK_BYTES - 6;
        pad <= TERMINAL_STREAM_CHUNK_BYTES + 2;
        pad += 1
      ) {
        const data = `${'a'.repeat(pad)}${unit.repeat(8)}${'z'.repeat(8)}`
        expectEquivalent(data, undefined, `window unit=${unit} pad=${pad}`)
        expectEquivalent(
          data,
          seqPreservingMeta(data, 777 + data.length),
          `window unit=${unit} pad=${pad} seq`
        )
        expectEquivalent(
          data,
          { seq: 777, rawLength: data.length + 1 },
          `window unit=${unit} pad=${pad} delayed`
        )
      }
    }
  })

  it('matches on the delayed-final-seq path across many chunk counts', () => {
    // rawLength !== data.length routes to OutputSpan; force the multi-chunk delayed
    // path by keeping rawLength === data.length but seq present with transformed=false,
    // then separately assert the true delayed shape (canPreserveChunkSeq=false).
    for (const chunkCount of [1, 2, 3, 5, 9]) {
      const data = `${'m'.repeat(TERMINAL_STREAM_CHUNK_BYTES * chunkCount)}${SURROGATE_PAIR}tail`
      expectEquivalent(data, { seq: 4242 }, `delayed chunks=${chunkCount} seq-only`)
      expectEquivalent(data, { seq: 4242, rawLength: 1 }, `delayed chunks=${chunkCount} raw=1`)
      expectEquivalent(data, undefined, `delayed chunks=${chunkCount} no-meta`)
    }
  })

  it('matches on realistic mixed terminal output', () => {
    const line = '\u001b[35m\u273b Thinking\u001b[0m about the \u20ac plan \u{1f600} 42 passed\r\n'
    for (const repeats of [1, 200, 2000, 6000]) {
      const data = line.repeat(repeats)
      sweepAll(data, `mixed repeats=${repeats}`)
    }
  })

  it('fuzzes 4000 short random payloads over the surrogate/control alphabet', () => {
    const random = makeRandom(0x5eed_1234)
    for (let trial = 0; trial < 4000; trial += 1) {
      const data = randomText(random, Math.floor(random() * 40))
      expectEquivalent(data, undefined, `fuzz-small trial=${trial}`)
      expectEquivalent(
        data,
        { seq: 31337, rawLength: data.length },
        `fuzz-small seq trial=${trial}`
      )
    }
  })

  it('fuzzes 800 near-cap payloads whose split point lands in the random region', () => {
    const random = makeRandom(0x1234_5eed)
    for (let trial = 0; trial < 800; trial += 1) {
      const fillerLength = TERMINAL_STREAM_CHUNK_BYTES - 6 + Math.floor(random() * 12)
      const data = 'q'.repeat(fillerLength) + randomText(random, 1 + Math.floor(random() * 24))
      expectEquivalent(data, undefined, `fuzz-cap trial=${trial}`)
      expectEquivalent(data, { seq: 88_888, rawLength: data.length }, `fuzz-cap seq trial=${trial}`)
      expectEquivalent(data, { seq: 88_888 }, `fuzz-cap delayed trial=${trial}`)
    }
  }, 30_000)

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
    expect([...legacyIterateTerminalOutputFrameChunks(exact)]).toHaveLength(1)
    const overByOne = `${exact}a`
    expect([...iterateTerminalOutputFrameChunks(overByOne)].length).toBeGreaterThan(1)
    expect([...legacyIterateTerminalOutputFrameChunks(overByOne)].length).toBeGreaterThan(1)
  })

  // The chunking loop is only reached when rawLength === data.length and transformed
  // is falsy, which makes canPreserveChunkSeq === (typeof meta.seq === 'number') and
  // therefore shouldDelayFinalSeq unconditionally false. The branch survives here
  // (it also survived in the pre-optimization code) purely as defence in depth.
  it('never reaches the delayed-final-seq branch for any meta shape', () => {
    for (const data of ['', 'a', 'abc', 'x'.repeat(200)]) {
      for (const seq of [undefined, 0, 5] as (number | undefined)[]) {
        for (const rawDelta of [undefined, 0, 1, -1] as (number | undefined)[]) {
          for (const transformed of [undefined, false, true] as (boolean | undefined)[]) {
            const meta: TerminalOutputMeta = {}
            if (seq !== undefined) {
              meta.seq = seq
            }
            if (rawDelta !== undefined) {
              meta.rawLength = data.length + rawDelta
            }
            if (transformed !== undefined) {
              meta.transformed = transformed
            }
            const rawLength = meta.rawLength ?? data.length
            const reachesChunkLoop = !meta.transformed && rawLength === data.length
            const canPreserveChunkSeq = typeof meta.seq === 'number' && rawLength === data.length
            const shouldDelayFinalSeq = !canPreserveChunkSeq && typeof meta.seq === 'number'
            expect(reachesChunkLoop && shouldDelayFinalSeq, JSON.stringify(meta)).toBe(false)
          }
        }
      }
    }
  })
})
