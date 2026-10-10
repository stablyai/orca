import { describe, expect, it, vi } from 'vitest'
import { readClipboardImageSource } from './clipboard-image-source'

function clipboardReader(filePath = '', itemCount = 1, formats: string[] = ['FileNameW']) {
  const shellItems = Buffer.alloc(4 + 4 * (itemCount + 1))
  shellItems.writeUInt32LE(itemCount)
  const buffers: Record<string, Buffer> = {
    FileNameW: Buffer.from(`${filePath}\0`, 'utf16le'),
    'Shell IDList Array': shellItems
  }
  return {
    availableFormats: vi.fn(() => formats),
    readBuffer: vi.fn((format: string) => buffers[format] ?? Buffer.alloc(0))
  }
}

describe('readClipboardImageSource', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'recognizes native image formats on %s without decoding',
    (platform) => {
      const clipboard = clipboardReader('', 1, ['text/plain', 'image/png'])
      expect(readClipboardImageSource(clipboard, platform)).toEqual({
        kind: 'native',
        windowsFileFormats: null
      })
    }
  )

  it.each(['darwin', 'linux', 'win32'] as const)('ignores ordinary text on %s', (platform) => {
    expect(readClipboardImageSource(clipboardReader('', 1, ['text/plain']), platform)).toBeNull()
  })

  it.each([
    'C:\\Users\\alice\\图片\\shot.PNG',
    '\\\\server\\share\\shot.jpeg',
    '\\\\?\\C:\\Users\\alice\\shot.jpg',
    '\\\\?\\UNC\\server\\share\\shot.png'
  ])('recognizes a supported single Windows image file: %s', (filePath) => {
    const clipboard = clipboardReader(filePath)
    const source = readClipboardImageSource(clipboard, 'win32')
    expect(source?.kind).toBe('windows-file')
    expect(source?.windowsFileFormats).toEqual({
      fileNameW: clipboard.readBuffer('FileNameW'),
      shellIdListArray: clipboard.readBuffer('Shell IDList Array')
    })
  })

  it.each([
    ['C:\\shot.pdf', 1],
    ['C:\\shot.webp', 1],
    ['C:\\shot.png', 2],
    ['shot.png', 1],
    ['C:shot.png', 1],
    ['\\\\server\\pipe\\shot.png', 1],
    ['C:\\one.png\0C:\\two.png', 1]
  ])('rejects an unsupported file source: %s (%s items)', (filePath, itemCount) => {
    expect(readClipboardImageSource(clipboardReader(filePath, itemCount), 'win32')).toBeNull()
  })

  it.each(['darwin', 'linux'] as const)('never reads Windows file formats on %s', (platform) => {
    const clipboard = clipboardReader('C:\\shot.png')
    expect(readClipboardImageSource(clipboard, platform)).toBeNull()
    expect(clipboard.readBuffer).not.toHaveBeenCalled()
  })

  it('keeps the copied-file fallback beside advertised native image data', () => {
    const clipboard = clipboardReader('C:\\shot.png', 1, ['image/png', 'FileNameW'])
    const source = readClipboardImageSource(clipboard, 'win32')
    expect(source?.kind).toBe('native')
    expect(source?.windowsFileFormats?.fileNameW).toEqual(clipboard.readBuffer('FileNameW'))
  })
})
