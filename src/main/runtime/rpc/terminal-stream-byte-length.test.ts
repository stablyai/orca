import { describe, expect, it } from 'vitest'
import {
  MIN_NATIVE_BYTE_LENGTH_CODE_UNITS,
  measureTerminalStreamByteLength,
  terminalStreamByteLength,
  terminalStreamByteLengthExceeds
} from './terminal-stream-byte-length'
import { TERMINAL_OUTPUT_BATCH_MAX_BYTES } from '../../../shared/terminal-multiplex-flow-control'

// Byte-for-byte copy of the pre-change implementation (shared/clipboard-text.ts
// measureClipboardTextByteLength), kept here so equivalence is checked against the
// ACTUAL old code path rather than a paraphrase of it.
function legacyUtf8ByteLengthForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}

function legacyMeasure(
  text: string,
  options: { stopAfterBytes?: number } = {}
): { byteLength: number; exceededLimit: boolean } {
  const stopAfterBytes = options.stopAfterBytes
  let byteLength = 0
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0
    byteLength += legacyUtf8ByteLengthForCodePoint(codePoint)
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return { byteLength, exceededLimit: true }
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return { byteLength, exceededLimit: false }
}

function legacyByteLength(data: string): number {
  return legacyMeasure(data).byteLength
}

function legacyExceeds(data: string, maxBytes: number): boolean {
  return legacyMeasure(data, { stopAfterBytes: maxBytes }).exceededLimit
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Mixed generator: ASCII, 2-byte, 3-byte, astral pairs, and LONE surrogates, so the
// fixtures exercise every branch of the legacy code-point scan.
function randomUnit(random: () => number): string {
  const roll = random()
  if (roll < 0.4) {
    return String.fromCharCode(Math.floor(random() * 0x80))
  }
  if (roll < 0.55) {
    return String.fromCharCode(0x80 + Math.floor(random() * 0x780))
  }
  if (roll < 0.72) {
    return String.fromCharCode(0x800 + Math.floor(random() * 0xd000))
  }
  if (roll < 0.88) {
    return String.fromCodePoint(0x10000 + Math.floor(random() * 0x100000))
  }
  return String.fromCharCode(0xd800 + Math.floor(random() * 0x800))
}

function randomString(random: () => number, maxUnits: number): string {
  const count = Math.floor(random() * maxUnits)
  let text = ''
  for (let index = 0; index < count; index += 1) {
    text += randomUnit(random)
  }
  return text
}

// Raw UTF-16 with no code-point discipline at all: catches anything that assumes
// well-formedness (unpaired high after high, low before high, etc).
function rawUtf16(random: () => number, maxUnits: number): string {
  const count = Math.floor(random() * maxUnits)
  let text = ''
  for (let index = 0; index < count; index += 1) {
    text += String.fromCharCode(Math.floor(random() * 0x11000))
  }
  return text
}

const EDGE_STRINGS = [
  '',
  'a',
  '\u0000',
  '\u007f',
  '',
  '߿',
  'ࠀ',
  '￿',
  '�',
  '\u{10000}',
  '\u{10ffff}',
  '\ud800',
  '\udfff',
  '\ud800\ud800',
  '\udc00\ud800',
  '😀',
  '😀\ud800',
  '\ud800😀',
  'a\ud800b',
  '\r\n\u001b[0m',
  'é́',
  '\u{1f469}‍\u{1f4bb}',
  'x'.repeat(1000),
  '\u{1f600}'.repeat(300),
  `${'é'.repeat(500)}\ud800`
]

describe('terminal stream byte length equivalence with the legacy code-point scan', () => {
  it('matches the legacy total byte length on edge strings', () => {
    for (const text of EDGE_STRINGS) {
      expect(terminalStreamByteLength(text)).toBe(legacyByteLength(text))
    }
  })

  it('matches the legacy total byte length over every Unicode code point', () => {
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const text = String.fromCodePoint(codePoint)
      if (terminalStreamByteLength(text) !== legacyByteLength(text)) {
        throw new Error(`byte length diverged at code point U+${codePoint.toString(16)}`)
      }
    }
    expect(terminalStreamByteLength('\u{10ffff}')).toBe(4)
  })

  it('matches the legacy total byte length over every lone surrogate', () => {
    for (let unit = 0xd800; unit <= 0xdfff; unit += 1) {
      const text = `a${String.fromCharCode(unit)}b`
      expect(terminalStreamByteLength(text)).toBe(legacyByteLength(text))
    }
  })

  it('matches the legacy total byte length over fuzzed mixed and raw UTF-16 input', () => {
    const random = mulberry32(0x5eed01)
    for (let iteration = 0; iteration < 20000; iteration += 1) {
      const text = iteration % 2 === 0 ? randomString(random, 24) : rawUtf16(random, 24)
      if (terminalStreamByteLength(text) !== legacyByteLength(text)) {
        throw new Error(`byte length diverged for ${JSON.stringify(text)}`)
      }
    }
    expect(true).toBe(true)
  })

  it('matches the legacy exceededLimit decision across a dense (string, limit) sweep', () => {
    const random = mulberry32(0xc0ffee)
    let compared = 0
    for (let iteration = 0; iteration < 10000; iteration += 1) {
      const text = iteration % 2 === 0 ? randomString(random, 16) : rawUtf16(random, 16)
      const total = legacyByteLength(text)
      // Sweep every limit from below zero to past the true total so the boundary is hit exactly.
      for (let limit = -2; limit <= total + 2; limit += 1) {
        if (terminalStreamByteLengthExceeds(text, limit) !== legacyExceeds(text, limit)) {
          throw new Error(`exceededLimit diverged for ${JSON.stringify(text)} at limit ${limit}`)
        }
        compared += 1
      }
    }
    expect(compared).toBeGreaterThan(100000)
  })

  it('matches the legacy exceededLimit decision for non-finite and fractional limits', () => {
    const random = mulberry32(0xfeed42)
    for (const limit of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0.5,
      2.5,
      -0.5,
      Number.MAX_SAFE_INTEGER
    ]) {
      for (let iteration = 0; iteration < 400; iteration += 1) {
        const text = rawUtf16(random, 12)
        expect(terminalStreamByteLengthExceeds(text, limit)).toBe(legacyExceeds(text, limit))
      }
      for (const text of EDGE_STRINGS) {
        expect(terminalStreamByteLengthExceeds(text, limit)).toBe(legacyExceeds(text, limit))
      }
    }
  })

  it('matches the legacy measurement pair, byteLength included, across a stopAfterBytes sweep', () => {
    const random = mulberry32(0xa11ce)
    for (let iteration = 0; iteration < 3000; iteration += 1) {
      const text = iteration % 2 === 0 ? randomString(random, 20) : rawUtf16(random, 20)
      const total = legacyByteLength(text)
      for (let stopAfterBytes = -1; stopAfterBytes <= total + 2; stopAfterBytes += 1) {
        const actual = measureTerminalStreamByteLength(text, { stopAfterBytes })
        const expected = legacyMeasure(text, { stopAfterBytes })
        if (
          actual.byteLength !== expected.byteLength ||
          actual.exceededLimit !== expected.exceededLimit
        ) {
          throw new Error(
            `measurement diverged for ${JSON.stringify(text)} at stopAfterBytes ${stopAfterBytes}`
          )
        }
      }
    }
    expect(
      measureTerminalStreamByteLength('\u{1f600}\u{1f600}\u{1f600}', { stopAfterBytes: 5 })
    ).toEqual(legacyMeasure('\u{1f600}\u{1f600}\u{1f600}', { stopAfterBytes: 5 }))
  })

  it('keeps the partial byteLength the legacy scan returned when the limit is exceeded', () => {
    // A drop-in Buffer.byteLength would report 12 here; the legacy scan stops at 8.
    const measurement = measureTerminalStreamByteLength('\u{1f600}\u{1f600}\u{1f600}', {
      stopAfterBytes: 5
    })
    expect(measurement).toEqual({ byteLength: 8, exceededLimit: true })
  })

  it('matches the legacy measurement with no stopAfterBytes and with an undefined option bag', () => {
    const random = mulberry32(0xb0b)
    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const text = rawUtf16(random, 32)
      expect(measureTerminalStreamByteLength(text)).toEqual(legacyMeasure(text))
      expect(measureTerminalStreamByteLength(text, {})).toEqual(legacyMeasure(text, {}))
      expect(measureTerminalStreamByteLength(text, { stopAfterBytes: undefined })).toEqual(
        legacyMeasure(text, { stopAfterBytes: undefined })
      )
    }
  })

  // The code-unit floor routes short inputs back through the scan. Both sides of that
  // boundary must stay legacy-identical, so sweep it exhaustively rather than by sampling.
  it('matches the legacy result on both sides of the native-call floor', () => {
    const random = mulberry32(0xf100a)
    for (let units = 0; units <= MIN_NATIVE_BYTE_LENGTH_CODE_UNITS * 2; units += 1) {
      for (let iteration = 0; iteration < 60; iteration += 1) {
        let text = ''
        while (text.length < units) {
          text +=
            iteration % 2 === 0
              ? randomUnit(random)
              : String.fromCharCode(Math.floor(random() * 0x11000))
        }
        text = text.slice(0, units)
        const total = legacyByteLength(text)
        expect(terminalStreamByteLength(text)).toBe(total)
        for (let limit = -1; limit <= total + 2; limit += 1) {
          if (terminalStreamByteLengthExceeds(text, limit) !== legacyExceeds(text, limit)) {
            throw new Error(`exceeds diverged at ${units} units, limit ${limit}`)
          }
          const actual = measureTerminalStreamByteLength(text, { stopAfterBytes: limit })
          const expected = legacyMeasure(text, { stopAfterBytes: limit })
          if (
            actual.byteLength !== expected.byteLength ||
            actual.exceededLimit !== expected.exceededLimit
          ) {
            throw new Error(`measurement diverged at ${units} units, limit ${limit}`)
          }
        }
      }
    }
    expect(MIN_NATIVE_BYTE_LENGTH_CODE_UNITS).toBeGreaterThan(0)
  })
})

// Reproduces createTerminalOutputBatcher's byte accounting exactly, under both the
// legacy scan and the new measurement, and asserts IDENTICAL flush boundaries. This is
// what makes the partial-count behaviour provably unobservable at that call site.
function simulateBatcherFlushes(
  chunks: string[],
  measure: (
    data: string,
    options: { stopAfterBytes?: number }
  ) => { byteLength: number; exceededLimit: boolean }
): string[] {
  const flushes: string[] = []
  let pending: string[] = []
  let bytes = 0
  const flush = (): void => {
    if (pending.length === 0) {
      return
    }
    flushes.push(pending.join(''))
    pending = []
    bytes = 0
  }
  for (const data of chunks) {
    if (!data) {
      continue
    }
    pending.push(data)
    const remainingBudget = Math.max(1, TERMINAL_OUTPUT_BATCH_MAX_BYTES - bytes)
    const measurement = measure(data, { stopAfterBytes: remainingBudget })
    bytes += measurement.byteLength
    if (measurement.exceededLimit || bytes >= TERMINAL_OUTPUT_BATCH_MAX_BYTES) {
      flush()
    }
  }
  flush()
  return flushes
}

describe('terminal output batcher flush boundaries are unchanged', () => {
  it(
    'produces identical flush boundaries over randomized multi-chunk runs',
    { timeout: 60000 },
    () => {
      const random = mulberry32(0x1337)
      for (let run = 0; run < 300; run += 1) {
        const chunks: string[] = []
        const chunkCount = 1 + Math.floor(random() * 40)
        for (let index = 0; index < chunkCount; index += 1) {
          // Sizes straddle the 64KiB batch cap so single chunks both fit and blow the budget.
          // Sizes straddle the native-call floor too, so runs mix scan-branch and
          // native-branch measurements inside one batcher's byte accounting.
          const scale = random()
          const maxUnits =
            scale < 0.25
              ? MIN_NATIVE_BYTE_LENGTH_CODE_UNITS * 2
              : scale < 0.5
                ? 64
                : scale < 0.85
                  ? 20000
                  : 90000
          chunks.push(random() < 0.5 ? randomString(random, maxUnits) : rawUtf16(random, maxUnits))
        }
        const legacyFlushes = simulateBatcherFlushes(chunks, legacyMeasure)
        const actualFlushes = simulateBatcherFlushes(chunks, measureTerminalStreamByteLength)
        if (legacyFlushes.length !== actualFlushes.length) {
          throw new Error(`flush count diverged on run ${run}`)
        }
        for (let index = 0; index < legacyFlushes.length; index += 1) {
          if (legacyFlushes[index] !== actualFlushes[index]) {
            throw new Error(`flush ${index} diverged on run ${run}`)
          }
        }
      }
      expect(true).toBe(true)
    }
  )

  it('exercises runs that actually cross the batch budget', () => {
    const oversized = '\u{1f600}'.repeat(TERMINAL_OUTPUT_BATCH_MAX_BYTES)
    const chunks = ['a'.repeat(10), oversized, 'b'.repeat(10), oversized, 'c']
    const legacyFlushes = simulateBatcherFlushes(chunks, legacyMeasure)
    expect(legacyFlushes.length).toBeGreaterThan(1)
    expect(simulateBatcherFlushes(chunks, measureTerminalStreamByteLength)).toEqual(legacyFlushes)
  })
})

// trimPendingOutputCoveredBySnapshot re-measures a sliced chunk with terminalStreamByteLength.
// The RPC suites never reach that slice branch (a `data.length` mutant there survives on
// unmodified HEAD too), so pin the byte accounting the branch depends on here.
describe('resync trim byte accounting for a snapshot-sliced chunk', () => {
  it('re-measures a sliced chunk in UTF-8 bytes, not UTF-16 code units', () => {
    const data = '\u{1f600}é走a'
    const sliced = data.slice(2)
    expect(terminalStreamByteLength(sliced)).toBe(legacyByteLength(sliced))
    // Guards the mutant: code-unit length would be 4 here, UTF-8 is 6.
    expect(terminalStreamByteLength(sliced)).toBe(6)
    expect(terminalStreamByteLength(sliced)).not.toBe(sliced.length)
  })

  it('matches the legacy byte length for every suffix slice of multi-byte terminal text', () => {
    const random = mulberry32(0x51ced)
    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const data = iteration % 2 === 0 ? randomString(random, 24) : rawUtf16(random, 24)
      for (let offset = 0; offset <= data.length; offset += 1) {
        const sliced = data.slice(offset)
        if (terminalStreamByteLength(sliced) !== legacyByteLength(sliced)) {
          throw new Error(`sliced byte length diverged for ${JSON.stringify(data)} at ${offset}`)
        }
      }
    }
    expect(true).toBe(true)
  })
})
