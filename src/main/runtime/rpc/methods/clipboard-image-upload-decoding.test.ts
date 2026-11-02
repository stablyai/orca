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
