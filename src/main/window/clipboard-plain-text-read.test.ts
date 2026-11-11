import { describe, expect, it, vi } from 'vitest'
import { readClipboardPlainText } from './clipboard-plain-text-read'

const URL_TEXT = 'https://example.com/한글'

function clipboardWith({
  text = '',
  formats = [],
  buffers = {}
}: {
  text?: string
  formats?: string[]
  buffers?: Record<string, Buffer>
}) {
  return {
    readText: vi.fn(() => text),
    availableFormats: vi.fn(() => formats),
    readBuffer: vi.fn((format: string) => buffers[format] ?? Buffer.alloc(0)),
    has: vi.fn(() => false)
  }
}

describe('readClipboardPlainText', () => {
  it('skips an undecodable plain-text type and uses the URL', () => {
    const buffers = {
      'public.plain-text': Buffer.from(URL_TEXT, 'utf16le'),
      'public.url': Buffer.from(URL_TEXT)
    }
    expect(readClipboardPlainText(clipboardWith({ buffers }), 'darwin')).toBe(URL_TEXT)
  })

  it('keeps a copied image out of the text path when it carries a source URL', () => {
    const clipboard = clipboardWith({
      formats: ['image/png'],
      buffers: { 'public.url': Buffer.from(URL_TEXT) }
    })
    expect(readClipboardPlainText(clipboard, 'darwin')).toBe('')
  })

  it('keeps a copied file out of the text path', () => {
    const clipboard = clipboardWith({
      buffers: {
        'public.file-url': Buffer.from('file:///tmp/a.txt'),
        'public.url': Buffer.from('file:///tmp/a.txt')
      }
    })
    expect(readClipboardPlainText(clipboard, 'darwin')).toBe('')
  })
})
