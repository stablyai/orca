import { describe, expect, it, vi } from 'vitest'
import { stringifyMobileOutboundJson } from './mobile-outbound-json'

describe('bounded mobile outbound JSON serialization', () => {
  it('preserves ordinary JSON values', () => {
    const value = { text: 'hello', escaped: '\u0000\n', items: [1, true, null] }

    expect(stringifyMobileOutboundJson(value, 1_000)).toBe(JSON.stringify(value))
  })

  it('stops before traversing fields after an oversized string', () => {
    const readAfter = vi.fn(() => 'late')
    const value = {
      payload: 'x'.repeat(100),
      get after() {
        return readAfter()
      }
    }

    expect(() => stringifyMobileOutboundJson(value, 32)).toThrow(
      'Mobile outbound JSON exceeds 32 bytes'
    )
    expect(readAfter).not.toHaveBeenCalled()
  })

  it('accounts for JSON escaping before the native serializer allocates output', () => {
    expect(stringifyMobileOutboundJson('\u0000', 8)).toBe('"\\u0000"')
    expect(() => stringifyMobileOutboundJson('\u0000', 7)).toThrow(
      'Mobile outbound JSON exceeds 7 bytes'
    )
  })

  it('accepts arrays and objects whose serialized form is exactly at the limit', () => {
    expect(stringifyMobileOutboundJson([1, 2], 5)).toBe('[1,2]')
    expect(stringifyMobileOutboundJson({ a: 1 }, 7)).toBe('{"a":1}')
    expect(() => stringifyMobileOutboundJson([1, 2], 4)).toThrow(
      'Mobile outbound JSON exceeds 4 bytes'
    )
    expect(() => stringifyMobileOutboundJson({ a: 1 }, 6)).toThrow(
      'Mobile outbound JSON exceeds 6 bytes'
    )
  })

  it('does not charge object properties omitted by JSON.stringify', () => {
    const value = {
      omittedUndefined: undefined,
      omittedFunction: () => 'ignored',
      omittedSymbol: Symbol('ignored'),
      kept: 1
    }

    expect(stringifyMobileOutboundJson(value, 10)).toBe('{"kept":1}')
  })

  it('serializes unsupported array elements as null within the exact limit', () => {
    const value = [undefined, () => 'ignored', Symbol('ignored')]

    expect(stringifyMobileOutboundJson(value, 16)).toBe('[null,null,null]')
    expect(() => stringifyMobileOutboundJson(value, 15)).toThrow(
      'Mobile outbound JSON exceeds 15 bytes'
    )
  })

  it('accounts for boxed JSON primitives without underestimating them', () => {
    expect(stringifyMobileOutboundJson(new String('\u0000'), 8)).toBe('"\\u0000"')
    expect(stringifyMobileOutboundJson(new Number(12345), 5)).toBe('12345')
    expect(stringifyMobileOutboundJson(new Boolean(false), 5)).toBe('false')
    expect(() => stringifyMobileOutboundJson(new String('\u0000'), 7)).toThrow(
      'Mobile outbound JSON exceeds 7 bytes'
    )
  })
})
