import { describe, expect, it, vi } from 'vitest'
import { isValidBase64 } from '../../../../shared/rpc-contract/clipboard-params'
import { decodeClipboardImageUpload } from './clipboard-image-upload-decoding'

describe('clipboard image upload decoding', () => {
  it.each([
    [],
    [''],
    ['AA', '=='],
    ['AAA', '='],
    ['AA', 'AA', 'AA'],
    ['AAAA', '==', ''],
    ['', 'A=', ''],
    ['A=='],
    ['AA', '', 'A', '', 'AAA', 'AA']
  ])('preserves decoding across partial quartets and padding: %j', (...chunks) => {
    expect(decodeClipboardImageUpload(chunks)).toEqual(Buffer.from(chunks.join(''), 'base64'))
  })

  it.each([
    ['AA==', 'AAAA'],
    ['AA', '==', '=='],
    ['AAA', 'AA'],
    ['AA=', '==']
  ])('rejects the same invalid complete payload: %j', (...chunks) => {
    expect(isValidBase64(chunks.join(''))).toBe(false)
    expect(() => decodeClipboardImageUpload(chunks)).toThrow(
      'Clipboard image content must be base64'
    )
  })

  it('matches whole-string validation and decoding for seeded arbitrary chunk boundaries', () => {
    let seed = 941
    const next = (max: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const alphabet = 'Az09+/'
    for (let sample = 0; sample < 5000; sample += 1) {
      const chunks: string[] = ['']
      const count = next(16)
      for (let index = 0; index < count; index += 1) {
        let size = 2 + next(12)
        if (size % 4 === 1) {
          size += 1
        }
        let chunk = ''
        for (let offset = 0; offset < size; offset += 1) {
          chunk += alphabet[next(alphabet.length)]
        }
        if (next(6) === 0) {
          const padding = 1 + next(2)
          chunk = chunk.slice(0, -padding) + '='.repeat(padding)
        }
        chunks.push(chunk)
      }
      chunks.push('')
      expect(chunks.every(isValidBase64)).toBe(true)
      const content = chunks.join('')
      if (isValidBase64(content)) {
        expect(decodeClipboardImageUpload(chunks)).toEqual(Buffer.from(content, 'base64'))
      } else {
        expect(() => decodeClipboardImageUpload(chunks)).toThrow(
          'Clipboard image content must be base64'
        )
      }
    }
  })

  it('initializes every output byte for permissive padding and partial quartets', () => {
    const allocate = vi
      .spyOn(Buffer, 'allocUnsafe')
      .mockImplementation((size) => Buffer.alloc(size, 205))
    try {
      for (let length = 0; length < 24; length += 1) {
        for (let padding = 0; padding <= 2; padding += 1) {
          const content = 'A'.repeat(length) + '='.repeat(padding)
          if (!isValidBase64(content)) {
            continue
          }
          for (let split = 0; split <= content.length; split += 1) {
            const decoded = decodeClipboardImageUpload([
              content.slice(0, split),
              content.slice(split)
            ])
            expect(decoded).toEqual(Buffer.from(content, 'base64'))
          }
        }
      }
    } finally {
      allocate.mockRestore()
    }
  })

  it('decodes a maximum-sized upload using only chunk-sized string inputs', () => {
    const chunkSize = 512 * 1024
    const chunks = Array.from({ length: 48 }, (_, index) =>
      Buffer.alloc((chunkSize / 4) * 3, index).toString('base64')
    )
    const write = vi.spyOn(Buffer.prototype, 'write')
    try {
      const decoded = decodeClipboardImageUpload(chunks)
      expect(decoded.length).toBe(18 * 1024 * 1024)
      expect(write).toHaveBeenCalledTimes(48)
      expect(
        write.mock.calls.every(([text]) => typeof text === 'string' && text.length <= chunkSize)
      ).toBe(true)
      for (let index = 0; index < 48; index += 1) {
        const offset = index * ((chunkSize / 4) * 3)
        expect(decoded[offset]).toBe(index)
        expect(decoded[offset + (chunkSize / 4) * 3 - 1]).toBe(index)
      }
    } finally {
      write.mockRestore()
    }
  })
})
