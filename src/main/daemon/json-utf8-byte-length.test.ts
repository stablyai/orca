import { describe, expect, it } from 'vitest'
import { jsonUtf8ByteLength } from './json-utf8-byte-length'

describe('jsonUtf8ByteLength', () => {
  it('matches JSON.stringify for escapes, Unicode, surrogates, and nested values', () => {
    const values: unknown[] = [
      '',
      '"\\\b\t\n\f\r\u0000\u001f',
      'plain ASCII',
      'é漢😀',
      '\ud800 lone high \udc00 lone low',
      {
        omitted: undefined,
        finite: -1.25e100,
        nonFinite: Number.POSITIVE_INFINITY,
        nested: ['😀', undefined, null, { control: '\u0001' }]
      }
    ]

    for (const value of values) {
      const json = JSON.stringify(value)
      expect(jsonUtf8ByteLength(value)).toBe(Buffer.byteLength(json, 'utf8'))
    }
  })

  it('rejects the same unsupported structural values as JSON.stringify', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => jsonUtf8ByteLength(circular)).toThrow('circular')
    expect(() => jsonUtf8ByteLength(1n)).toThrow('BigInt')
  })
})
