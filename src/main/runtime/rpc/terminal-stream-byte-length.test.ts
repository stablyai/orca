import { describe, expect, it } from 'vitest'
import {
  measureTerminalStreamByteLength,
  terminalStreamByteLength,
  terminalStreamByteLengthExceeds
} from './terminal-stream-byte-length'

describe('measuring a prefix slice that cuts a surrogate pair in half', () => {
  // Kept first in the file so the scan is still specializing on this shape when it tiers up.
  it('measures the slice like the encoder does in every JIT tier', () => {
    const sliced = 'abcdefghijkl\u{1f600}'.slice(0, 13)
    expect(sliced.length).toBe(13)
    expect(sliced.charCodeAt(12)).toBe(0xd83d)
    // 12 ASCII bytes plus U+FFFD for the orphaned high surrogate.
    expect(Buffer.byteLength(sliced, 'utf8')).toBe(15)

    const observedByteLengths = new Set<number>()
    const observedExceeded = new Set<boolean>()
    const observedMeasurements = new Set<string>()
    for (let iteration = 0; iteration < 200_000; iteration += 1) {
      observedByteLengths.add(terminalStreamByteLength(sliced))
      observedExceeded.add(terminalStreamByteLengthExceeds(sliced, 15))
      observedMeasurements.add(
        JSON.stringify(measureTerminalStreamByteLength(sliced, { stopAfterBytes: 15 }))
      )
    }
    expect([...observedByteLengths]).toEqual([15])
    expect([...observedExceeded]).toEqual([false])
    expect([...observedMeasurements]).toEqual([
      JSON.stringify({ byteLength: 15, exceededLimit: false })
    ])
  })
})

describe('terminal stream UTF-8 byte accounting', () => {
  it('matches the encoder across Unicode widths and the native-call boundary', () => {
    const samples = [
      '',
      '\u0000\u007f',
      '\u0080\u07ff',
      '\u0800\uffff',
      '\u{10000}\u{10ffff}',
      '\ud800',
      '\udfff',
      '\ud800\ud800',
      '\udc00\ud800',
      '😀\ud800',
      '\ud800😀',
      'e\u0301',
      '👩‍💻',
      '\r\n\u001b[0m'
    ]
    for (const units of [15, 16, 17, 32]) {
      for (const unit of ['a', 'é', '走', '😀', '\ud800']) {
        samples.push(unit.repeat(units).slice(0, units))
      }
    }
    for (const text of samples) {
      const byteLength = Buffer.byteLength(text, 'utf8')
      expect(terminalStreamByteLength(text), JSON.stringify(text)).toBe(byteLength)
      expect(measureTerminalStreamByteLength(text)).toEqual({
        byteLength,
        exceededLimit: false
      })
      for (const limit of [-1, 0, 0.5, byteLength - 1, byteLength, byteLength + 1]) {
        expect(
          terminalStreamByteLengthExceeds(text, limit),
          `${JSON.stringify(text)} at ${limit}`
        ).toBe(text.length > 0 && byteLength > limit)
      }
    }
  })

  it.each([
    { text: '', limit: -1, byteLength: 0, exceededLimit: false },
    { text: 'abc', limit: 0, byteLength: 1, exceededLimit: true },
    { text: 'éé', limit: 2, byteLength: 4, exceededLimit: true },
    { text: '😀😀😀', limit: 5, byteLength: 8, exceededLimit: true },
    { text: '\ud800z', limit: 2, byteLength: 3, exceededLimit: true },
    { text: '😀'.repeat(9), limit: 5, byteLength: 8, exceededLimit: true },
    { text: 'é'.repeat(16), limit: 32, byteLength: 32, exceededLimit: false },
    { text: '走'.repeat(16), limit: 48, byteLength: 48, exceededLimit: false }
  ])(
    'measures only through the first code point over $limit bytes',
    ({ text, limit, ...expected }) => {
      expect(measureTerminalStreamByteLength(text, { stopAfterBytes: limit })).toEqual(expected)
    }
  )

  it('treats non-finite limits as unbounded for both scan and native inputs', () => {
    for (const text of ['', '😀é走a', '😀é走a'.repeat(8)]) {
      for (const limit of [Number.NaN, Infinity, -Infinity]) {
        expect(terminalStreamByteLengthExceeds(text, limit)).toBe(false)
        expect(measureTerminalStreamByteLength(text, { stopAfterBytes: limit })).toEqual({
          byteLength: Buffer.byteLength(text, 'utf8'),
          exceededLimit: false
        })
      }
    }
  })
})
