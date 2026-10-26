import { describe, expect, it } from 'vitest'

import { describeQuoteStrippedJsonFlag, looksQuoteStripped } from './quote-stripped-json-flag'

describe('quote-stripped JSON flag detection', () => {
  it('flags the exact shape measured from Windows PowerShell 5.1', () => {
    // PowerShell 5.1 passed this shape after ConvertTo-Json emitted quoted task ids.
    expect(looksQuoteStripped('[task_b2a580db74d8,task_c3b691ec85e9]')).toBe(true)
    expect(looksQuoteStripped('[a,b]')).toBe(true)
    expect(looksQuoteStripped('{a:b}')).toBe(true)
  })

  it('leaves valid JSON alone', () => {
    expect(looksQuoteStripped('["a","b"]')).toBe(false)
    expect(looksQuoteStripped('{"a":"b"}')).toBe(false)
    expect(looksQuoteStripped('[1,2]')).toBe(false)
    expect(looksQuoteStripped('[]')).toBe(false)
    expect(looksQuoteStripped('{}')).toBe(false)
  })

  it('does not claim mangling for values quoting would not rescue', () => {
    expect(looksQuoteStripped('not json at all')).toBe(false)
    expect(looksQuoteStripped('[a b, c]')).toBe(false)
    expect(looksQuoteStripped('[a,,b]')).toBe(false)
  })

  it('requires a key:value pair per entry before calling an object stripped', () => {
    expect(looksQuoteStripped('{a,b}')).toBe(false)
    expect(looksQuoteStripped('{a:b,c}')).toBe(false)
    expect(looksQuoteStripped('{:b}')).toBe(false)
    expect(looksQuoteStripped('{a:}')).toBe(false)
    expect(looksQuoteStripped('{a:b}')).toBe(true)
    expect(looksQuoteStripped('{a:b,c:d}')).toBe(true)
  })

  it('explains the likely cause without echoing the value', () => {
    const message = describeQuoteStrippedJsonFlag('payload', '{secret:hunter2}')
    expect(message).toContain('--payload is not valid JSON')
    expect(message).toContain('PowerShell 5.1')
    expect(message).toContain('$v')
    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('secret')
    expect(describeQuoteStrippedJsonFlag('options', '["a","b"]')).toBeNull()
  })

  it('hedges the shell attribution, since it inspects only the value shape', () => {
    expect(describeQuoteStrippedJsonFlag('options', '[a,b]')).toContain('If you ran this from')
  })
})
