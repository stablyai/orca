import { describe, expect, it } from 'vitest'
import { parseContentRange, parseRetryAfterMs } from './speech-model-download-response'

describe('speech model download response contracts', () => {
  it('accepts only internally consistent byte ranges', () => {
    expect(parseContentRange('bytes 10-19/20')).toEqual({ start: 10, end: 19, totalBytes: 20 })
    expect(parseContentRange('bytes 10-20/20')).toBeNull()
    expect(parseContentRange('bytes 20-10/21')).toBeNull()
    expect(parseContentRange('not-a-range')).toBeNull()
  })

  it('bounds numeric retry delays to safe integers', () => {
    expect(parseRetryAfterMs('12')).toBe(12_000)
    expect(parseRetryAfterMs(String(Number.MAX_SAFE_INTEGER))).toBeUndefined()
    expect(parseRetryAfterMs('invalid')).toBeUndefined()
  })
})
