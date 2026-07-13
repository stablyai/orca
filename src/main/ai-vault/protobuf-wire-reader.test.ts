import { describe, expect, it } from 'vitest'
import { messageField, stringField, tag, varintField } from './protobuf-test-encoder'
import { pbFindString, pbMessage, pbPath, pbString, pbVarint } from './protobuf-wire-reader'

// buf assembles fixture byte arrays from the shared field encoders.
function buf(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat())
}

describe('protobuf-wire-reader', () => {
  it('reads a varint field by number', () => {
    const message = buf(varintField(1, 14), varintField(4, 3))
    expect(pbVarint(message, 1)).toBe(14)
    expect(pbVarint(message, 4)).toBe(3)
  })

  it('reads a length-delimited utf-8 string field, including multibyte text', () => {
    const message = buf(stringField(2, '클로드랑 대화해서 점수향상좀'))
    expect(pbString(message, 2)).toBe('클로드랑 대화해서 점수향상좀')
  })

  it('returns null for a field that is absent', () => {
    const message = buf(varintField(1, 14))
    expect(pbString(message, 19)).toBeNull()
    expect(pbVarint(message, 4)).toBeNull()
    expect(pbMessage(message, 5)).toBeNull()
  })

  it('reads nested messages via pbPath', () => {
    // #5 { #1 { #1 = seconds, #2 = nanos } }
    const inner = varintField(1, 1783694042).concat(varintField(2, 406941000))
    const message = buf(messageField(5, messageField(1, inner)))
    const timestamp = pbPath(message, [5, 1])
    expect(timestamp).not.toBeNull()
    expect(pbVarint(timestamp as Uint8Array, 1)).toBe(1783694042)
    expect(pbVarint(timestamp as Uint8Array, 2)).toBe(406941000)
  })

  it('decodes varints whose value needs a shift of 32 bits or more', () => {
    // JS `<<` is 32-bit; a naive shift-based decoder corrupts large values.
    const large = 2 ** 40 + 123
    const message = buf(varintField(3, large))
    expect(pbVarint(message, 3)).toBe(large)
  })

  it('returns the first occurrence when a field repeats', () => {
    const message = buf(stringField(2, 'first'), stringField(2, 'second'))
    expect(pbString(message, 2)).toBe('first')
  })

  it('does not throw on a truncated tail, returning what it can', () => {
    // A valid string field #2, then a dangling tag with no body.
    const message = buf(stringField(2, 'ok'), tag(9, 2))
    expect(pbString(message, 2)).toBe('ok')
    expect(pbString(message, 9)).toBeNull()
  })
})

describe('pbFindString', () => {
  it('finds a string matching the predicate nested several messages deep', () => {
    // #5 { #20 { #12 = "file:///Users/macbook/Desktop/proj" } }
    const uri = 'file:///Users/macbook/Desktop/proj'
    const message = buf(messageField(5, messageField(20, stringField(12, uri))))
    expect(pbFindString(message, (text) => text.startsWith('file://'))).toBe(uri)
  })

  it('returns null when no string satisfies the predicate', () => {
    const message = buf(messageField(5, stringField(12, '/plain/path')))
    expect(pbFindString(message, (text) => text.startsWith('file://'))).toBeNull()
  })

  it('skips non-utf8 binary fields without throwing', () => {
    // messageField here carries intentionally invalid utf-8 bytes, then the
    // real match follows.
    const uri = 'file:///w'
    const message = buf(messageField(3, [0xff, 0xfe, 0xfd]), stringField(4, uri))
    expect(pbFindString(message, (text) => text.startsWith('file://'))).toBe(uri)
  })
})
