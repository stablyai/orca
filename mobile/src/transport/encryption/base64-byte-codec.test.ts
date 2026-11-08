import { describe, expect, it } from 'vitest'
import { encodeBase64Bytes } from './base64-byte-codec'

describe('base64 byte codec', () => {
  it('keeps the fallback when the native property is not callable', () => {
    const bytes = new Uint8Array([255, 254])
    Object.defineProperty(bytes, 'toBase64', { value: undefined })
    expect(encodeBase64Bytes(bytes)).toBe('//4=')
  })

  it('preserves empty encoding for a detached byte view', () => {
    const bytes = new Uint8Array([1, 2, 3])
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] })
    expect(encodeBase64Bytes(bytes)).toBe('')
  })
})
