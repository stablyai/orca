import { describe, expect, it } from 'vitest'
import { decodeBase64Bytes, encodeBase64Bytes } from './base64-byte-codec'

describe('base64 byte codec', () => {
  it.each([0, 1, 2, 3, 4, 8190 - 1, 8190, 8190 + 1, 8190 + 2, 8190 * 2, 256 * 1024 + 1])(
    'preserves all bytes and padding at size %i',
    (length) => {
      const backing = new Uint8Array(length + 7)
      for (let index = 0; index < backing.length; index++) {
        backing[index] = (index * 97 + 13) % 256
      }
      const bytes = backing.subarray(3, length + 3)
      const encoded = encodeBase64Bytes(bytes)
      expect(encoded).toBe(Buffer.from(bytes).toString('base64'))
      expect(decodeBase64Bytes(encoded)).toEqual(bytes)
    }
  )

  it.each(['', 'AA', 'AQ==', 'AR==', 'A Q==', 'AQ==\n', '/w==', '//8=', '////'])(
    'keeps the existing atob decoding behavior for %j',
    (value) => {
      expect(decodeBase64Bytes(value)).toEqual(new Uint8Array(Buffer.from(atob(value), 'latin1')))
    }
  )

  it.each(['A', 'A===', 'A!AA', '_w==', 'πAAA', 'AA=AA'])(
    'rejects malformed base64: %j',
    (value) => {
      expect(() => atob(value)).toThrow()
      expect(() => decodeBase64Bytes(value)).toThrow()
    }
  )
})
