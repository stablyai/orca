import { describe, expect, it, vi } from 'vitest'
import { readClipboardImageForImport } from './clipboard-image-import-source'
import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
} from '../../shared/clipboard-image'

function makeClipboard(buffers: Record<string, Buffer> = {}, formats = ['image/png']) {
  const image = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 2, height: 2 })),
    toPNG: vi.fn(() => Buffer.from('encoded PNG'))
  }
  return {
    image,
    availableFormats: vi.fn(() => formats),
    has: vi.fn((_format: string) => false),
    readBuffer: vi.fn((format: string) => buffers[format] ?? Buffer.alloc(0)),
    readImage: vi.fn(() => image)
  }
}

describe('clipboard image import source', () => {
  it.each(['win32', 'darwin', 'linux'] as const)(
    'captures native pixels beside HTML and text on %s',
    (platform) => {
      const clipboard = makeClipboard({}, ['text/plain', 'text/html', 'image/png'])
      expect(readClipboardImageForImport(clipboard, platform)).toEqual(Buffer.from('encoded PNG'))
      expect(clipboard.readImage).toHaveBeenCalledOnce()
      expect(clipboard.image.toPNG).toHaveBeenCalledOnce()
    }
  )

  it.each(['win32', 'darwin', 'linux'] as const)('ignores text and URLs on %s', (platform) => {
    const clipboard = makeClipboard({}, ['text/plain', 'text/html', 'text/uri-list'])
    expect(readClipboardImageForImport(clipboard, platform)).toBeNull()
    expect(clipboard.readImage).not.toHaveBeenCalled()
  })

  it.each([
    ['win32', { FileNameW: Buffer.from('C:\\image.jpg\0', 'utf16le') }],
    ['darwin', { 'public.file-url': Buffer.from('file:///images/image.jpg') }],
    ['linux', { 'text/uri-list': Buffer.from('file:///images/image.jpg\r\n') }]
  ] satisfies [NodeJS.Platform, Record<string, Buffer>][])(
    'preserves explicit file copies even alongside image pixels on %s',
    (platform, buffers) => {
      const clipboard = makeClipboard(buffers)
      expect(readClipboardImageForImport(clipboard, platform)).toBeNull()
      expect(clipboard.readImage).not.toHaveBeenCalled()
    }
  )

  it('never falls back to opening a Windows image file', () => {
    const clipboard = makeClipboard({ FileNameW: Buffer.from('C:\\image.jpg\0', 'utf16le') }, [
      'FileNameW'
    ])
    expect(readClipboardImageForImport(clipboard, 'win32')).toBeNull()
    expect(clipboard.readImage).not.toHaveBeenCalled()
  })

  it('does not import a native preview of a multi-file Windows copy', () => {
    const items = Buffer.alloc(16)
    items.writeUInt32LE(2)
    const clipboard = makeClipboard({
      FileNameW: Buffer.from('C:\\one.jpg\0', 'utf16le'),
      'Shell IDList Array': items
    })
    expect(readClipboardImageForImport(clipboard, 'win32')).toBeNull()
    expect(clipboard.readImage).not.toHaveBeenCalled()
  })

  it.each(['public.png', 'public.tiff'])(
    'accepts macOS %s omitted from format enumeration',
    (format) => {
      const clipboard = makeClipboard({}, [])
      clipboard.has.mockImplementation((value) => value === format)
      expect(readClipboardImageForImport(clipboard, 'darwin')).toEqual(Buffer.from('encoded PNG'))
    }
  )

  it('decodes through the supplied reader when readImage sees no pixels', () => {
    const clipboard = makeClipboard()
    clipboard.image.isEmpty.mockReturnValue(true)
    const decoded = {
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 2 }),
      toPNG: () => Buffer.from('re-encoded JPEG')
    }
    expect(readClipboardImageForImport(clipboard, 'darwin', () => decoded)).toEqual(
      Buffer.from('re-encoded JPEG')
    )
    expect(clipboard.readImage).not.toHaveBeenCalled()
  })

  it('ignores empty native images', () => {
    const clipboard = makeClipboard()
    clipboard.image.isEmpty.mockReturnValue(true)
    expect(readClipboardImageForImport(clipboard, 'linux')).toBeNull()
    expect(clipboard.image.toPNG).not.toHaveBeenCalled()
  })

  it('rejects oversized dimensions before encoding', () => {
    const clipboard = makeClipboard()
    clipboard.image.getSize.mockReturnValue({ width: CLIPBOARD_IMAGE_MAX_PIXELS + 1, height: 1 })
    expect(() => readClipboardImageForImport(clipboard, 'linux')).toThrow('too large')
    expect(clipboard.image.toPNG).not.toHaveBeenCalled()
  })

  it('rejects oversized or empty PNG output', () => {
    const clipboard = makeClipboard()
    clipboard.image.toPNG.mockReturnValue(Buffer.alloc(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1))
    expect(() => readClipboardImageForImport(clipboard, 'linux')).toThrow('too large')
    clipboard.image.toPNG.mockReturnValue(Buffer.alloc(0))
    expect(() => readClipboardImageForImport(clipboard, 'linux')).toThrow('encoded as PNG')
  })
})
