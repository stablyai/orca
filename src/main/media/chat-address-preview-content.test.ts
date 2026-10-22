import { describe, expect, it } from 'vitest'
import {
  inspectPreviewContent,
  previewContentLimit,
  CHAT_PREVIEW_MAX_TEXT_BYTES,
  CHAT_PREVIEW_MAX_PDF_BYTES
} from './chat-address-preview-content'

describe('chat address preview content inspection', () => {
  it('uses actual image bytes rather than a document extension or misleading response MIME', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    expect(inspectPreviewContent(png, 'download.md', 'text/html')).toEqual({
      kind: 'image',
      mimeType: 'image/png'
    })
  })

  it.each(['BM', 'BMI results for this appointment'])(
    'keeps text beginning with %s out of the BMP decoder',
    (text) => {
      expect(inspectPreviewContent(Buffer.from(text), 'notes.md')).toEqual({
        kind: 'markdown',
        mimeType: 'text/markdown'
      })
      expect(inspectPreviewContent(Buffer.from(text), 'notes.txt')).toEqual({
        kind: 'text',
        mimeType: 'text/plain'
      })
    }
  )

  it.each([12, 16, 40, 52, 56, 64, 108, 124])(
    'recognizes a BMP with a complete %i-byte DIB header',
    (headerSize) => {
      const bytes = Buffer.alloc(14 + headerSize)
      bytes.write('BM')
      bytes.writeUInt32LE(headerSize, 14)
      expect(inspectPreviewContent(bytes, 'download')).toEqual({
        kind: 'image',
        mimeType: 'image/bmp'
      })
      expect(inspectPreviewContent(bytes.subarray(0, -1), 'download').kind).toBe('file')
    }
  )

  it('uses MIME to recognize extensionless Markdown while treating executable documents as text', () => {
    expect(
      inspectPreviewContent(Buffer.from('# Notes'), 'download', 'text/markdown; charset=utf-8')
    ).toEqual({ kind: 'markdown', mimeType: 'text/markdown' })
    expect(
      inspectPreviewContent(
        Buffer.from('<!doctype html><script>alert(1)</script>'),
        'download',
        'text/html'
      )
    ).toEqual({ kind: 'text', mimeType: 'text/plain' })
    expect(
      inspectPreviewContent(Buffer.from('alert(1)'), 'script.js', 'application/javascript')
    ).toEqual({ kind: 'text', mimeType: 'text/plain' })
  })

  it('recognizes PDF and media signatures on extensionless responses', () => {
    expect(inspectPreviewContent(Buffer.from('%PDF-1.7'), 'download')).toEqual({
      kind: 'pdf',
      mimeType: 'application/pdf'
    })
    expect(
      inspectPreviewContent(Buffer.from('000000186674797069736f6d', 'hex'), 'download')
    ).toEqual({ kind: 'video', mimeType: 'video/mp4' })
    expect(
      inspectPreviewContent(Buffer.from('00000018667479704d344120', 'hex'), 'download')
    ).toEqual({ kind: 'audio', mimeType: 'audio/mp4' })
    expect(inspectPreviewContent(Buffer.from('1a45dfa3', 'hex'), 'download', 'video/webm')).toEqual(
      { kind: 'video', mimeType: 'video/webm' }
    )
  })

  it('keeps unknown binary and invalid UTF-8 as metadata, even with a text MIME', () => {
    expect(inspectPreviewContent(Buffer.from([0, 1, 2, 3]), 'secret.md', 'text/plain')).toEqual({
      kind: 'file',
      mimeType: 'application/octet-stream'
    })
    expect(inspectPreviewContent(Buffer.from([0xc0, 0xaf]), 'download', 'text/plain')).toEqual({
      kind: 'file',
      mimeType: 'application/octet-stream'
    })
  })

  it('does not misclassify AVIF/HEIC image containers as playable MP4 recordings', () => {
    expect(
      inspectPreviewContent(
        Buffer.from('000000186674797061766966', 'hex'),
        'download',
        'image/avif'
      ).kind
    ).toBe('file')
  })

  it('uses smaller limits for text than PDFs', () => {
    expect(previewContentLimit('text')).toBe(CHAT_PREVIEW_MAX_TEXT_BYTES)
    expect(previewContentLimit('markdown')).toBe(CHAT_PREVIEW_MAX_TEXT_BYTES)
    expect(previewContentLimit('pdf')).toBe(CHAT_PREVIEW_MAX_PDF_BYTES)
  })
})
