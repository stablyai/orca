import { describe, expect, it } from 'vitest'
import { readClipboardCopiedFilePaths } from './clipboard-copied-file-paths'

function clipboardWith(formats: Record<string, Buffer | string>) {
  return {
    readBuffer: (format: string): Buffer => {
      const value = formats[format]
      return typeof value === 'string' ? Buffer.from(value, 'utf8') : (value ?? Buffer.alloc(0))
    }
  }
}

function filenamesPlist(paths: string[]): string {
  const entries = paths.map((path) => `<string>${path}</string>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${entries}</array></plist>`
}

describe('readClipboardCopiedFilePaths', () => {
  it.each([
    [
      'darwin',
      'file:///Users/me/a%20b.png\r\nfile:///Users/me/c.txt',
      ['/Users/me/a b.png', '/Users/me/c.txt']
    ],
    [
      'win32',
      'file:///C:/Users/me/a%20b.png\r\nfile:///C:/Users/me/c.txt',
      ['C:\\Users\\me\\a b.png', 'C:\\Users\\me\\c.txt']
    ]
  ] as const)(
    'reads native file lists exposed as URI lists on %s',
    async (platform, urls, paths) => {
      expect(
        await readClipboardCopiedFilePaths(clipboardWith({ 'text/uri-list': urls }), platform)
      ).toEqual(paths)
    }
  )

  it('lists every file Finder copied, decoding XML entities', async () => {
    const clipboard = clipboardWith({
      NSFilenamesPboardType: filenamesPlist(['/Users/me/Q&amp;A shot.png', '/Users/me/b.pdf']),
      'public.file-url': 'file:///Users/me/Q&A%20shot.png'
    })
    expect(await readClipboardCopiedFilePaths(clipboard, 'darwin')).toEqual([
      '/Users/me/Q&A shot.png',
      '/Users/me/b.pdf'
    ])
  })

  it('falls back to the first file URL on macOS, but not a file-reference URL', async () => {
    expect(
      await readClipboardCopiedFilePaths(
        clipboardWith({ 'public.file-url': 'file:///Users/me/my%20shot.png' }),
        'darwin'
      )
    ).toEqual(['/Users/me/my shot.png'])
    expect(
      await readClipboardCopiedFilePaths(
        clipboardWith({ 'public.file-url': 'file:///.file/id=6571367.2773272' }),
        'darwin'
      )
    ).toEqual([])
  })

  it('reads a Linux file manager uri-list and rejects non-file entries', async () => {
    expect(
      await readClipboardCopiedFilePaths(
        clipboardWith({
          'text/uri-list': '# copied\r\nfile:///home/me/a.png\r\nfile:///home/me/b%20c.txt\r\n'
        }),
        'linux'
      )
    ).toEqual(['/home/me/a.png', '/home/me/b c.txt'])
    expect(
      await readClipboardCopiedFilePaths(
        clipboardWith({ 'text/uri-list': 'file:///home/me/a.png\nhttps://example.com/x' }),
        'linux'
      )
    ).toEqual([])
  })

  it('rejects URI lists containing NUL bytes or malformed file URLs', async () => {
    for (const urls of ['file:///C:/shot%00.png', 'file:///C:/shot%GG.png']) {
      expect(
        await readClipboardCopiedFilePaths(clipboardWith({ 'text/uri-list': urls }), 'win32')
      ).toEqual([])
    }
  })

  it('reads the single file Explorer copied and nothing when it copied several', async () => {
    const shellItems = (count: number): Buffer => {
      const cida = Buffer.alloc(4 + 4 * (count + 1))
      cida.writeUInt32LE(count)
      return cida
    }
    const explorer = (count: number) =>
      clipboardWith({
        FileNameW: Buffer.from('C:\\Users\\me\\shot.png\0', 'utf16le'),
        'Shell IDList Array': shellItems(count)
      })
    expect(await readClipboardCopiedFilePaths(explorer(1), 'win32')).toEqual([
      'C:\\Users\\me\\shot.png'
    ])
    expect(await readClipboardCopiedFilePaths(explorer(2), 'win32')).toEqual([])
  })

  it('returns nothing for plain text, oversized lists, or a failing clipboard', async () => {
    expect(await readClipboardCopiedFilePaths(clipboardWith({}), 'darwin')).toEqual([])
    const huge = filenamesPlist(['/a'.padEnd(300 * 1024, 'a')])
    expect(
      await readClipboardCopiedFilePaths(clipboardWith({ NSFilenamesPboardType: huge }), 'darwin')
    ).toEqual([])
    const failing = {
      readBuffer: (): Buffer => {
        throw new Error('format unavailable')
      }
    }
    expect(await readClipboardCopiedFilePaths(failing, 'linux')).toEqual([])
  })
})
