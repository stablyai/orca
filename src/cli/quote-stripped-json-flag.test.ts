import { describe, expect, it } from 'vitest'

import { describeQuoteStrippedJsonFlag, looksQuoteStripped } from './quote-stripped-json-flag'

describe('quote-stripped JSON flag detection', () => {
  it('flags the exact shape measured from Windows PowerShell 5.1', () => {
    // Measured on a real Windows host: ConvertTo-Json emitted
    // ["task_b2a580db74d8","task_c3b691ec85e9"] and argv received the value below.
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

  it('names the shell rather than blaming the value', () => {
    const message = describeQuoteStrippedJsonFlag('options', '[a,b]')
    expect(message).toContain('--options arrived as [a,b]')
    expect(message).toContain('PowerShell 5.1')
    expect(message).toContain('$v')
    expect(describeQuoteStrippedJsonFlag('options', '["a","b"]')).toBeNull()
  })
})
