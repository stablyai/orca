import { describe, expect, it } from 'vitest'
import { detectImageFileSignature, IMAGE_SIGNATURE_BYTES } from './image-file-signature'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]

describe('detectImageFileSignature', () => {
  it.each([
    ['png', Buffer.from(PNG), 'image/png'],
    ['jpg', Buffer.from(JPEG), 'image/jpeg'],
    ['gif', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1'), 'image/gif'],
    ['gif', Buffer.from('GIF87a\x01\x00\x01\x00\x00\x00', 'latin1'), 'image/gif'],
    ['webp', Buffer.from('RIFF\x24\x00\x00\x00WEBP', 'latin1'), 'image/webp']
  ])('recognizes %s from its leading bytes', (extension, header, mimeType) => {
    expect(header.length).toBeLessThanOrEqual(IMAGE_SIGNATURE_BYTES)
    expect(detectImageFileSignature(header)).toEqual({ mimeType, extension })
  })

  it.each([
    ['empty input', Buffer.alloc(0)],
    ['text', Buffer.from('hello world!')],
    ['a PDF', Buffer.from('%PDF-1.7\n%\xe2\xe3', 'latin1')],
    ['a RIFF file that is not WebP', Buffer.from('RIFF\x24\x00\x00\x00WAVE', 'latin1')],
    ['a truncated PNG header', Buffer.from(PNG.slice(0, 4))]
  ])('rejects %s', (_label, header) => {
    expect(detectImageFileSignature(header)).toBeNull()
  })
})
