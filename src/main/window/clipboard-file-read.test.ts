import { describe, expect, it } from 'vitest'
import { readClipboardFilePaths } from './clipboard-file-read'

function deps(platform: NodeJS.Platform, formats: Record<string, Buffer | string>) {
  return {
    platform,
    readBuffer: (format: string): Buffer => {
      const value = formats[format]
      if (value === undefined) {
        return Buffer.alloc(0)
      }
      return typeof value === 'string' ? Buffer.from(value, 'utf8') : value
    }
  }
}

function filenamesPlist(paths: string[]): string {
  const entries = paths.map((path) => `\t<string>${path}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<array>\n${entries}\n</array>\n</plist>\n`
}

function fileNameW(filePath: string): Buffer {
  return Buffer.from(`${filePath}\0`, 'utf16le')
}

function shellIdListArray(itemCount: number): Buffer {
  const value = Buffer.alloc(4 + 4 * (itemCount + 1))
  value.writeUInt32LE(itemCount)
  return value
}

describe('readClipboardFilePaths', () => {
  it('reads every Finder-copied path from NSFilenamesPboardType, decoding XML entities', () => {
    expect(
      readClipboardFilePaths(
        deps('darwin', {
          NSFilenamesPboardType: filenamesPlist([
            '/Users/me/sub dir/a &amp; b.txt',
            '/Users/me/plain.txt'
          ]),
          'public.file-url': 'file:///Users/me/sub%20dir/a%20%26%20b.txt'
        })
      )
    ).toEqual(['/Users/me/sub dir/a & b.txt', '/Users/me/plain.txt'])
  })

  it('falls back to the percent-encoded public.file-url without a filename list', () => {
    expect(
      readClipboardFilePaths(
        deps('darwin', { 'public.file-url': 'file:///Users/me/sub%20dir/hello%20world.txt' })
      )
    ).toEqual(['/Users/me/sub dir/hello world.txt'])
  })

  it('returns no paths for a text-only macOS clipboard', () => {
    expect(readClipboardFilePaths(deps('darwin', {}))).toEqual([])
  })

  it('decodes a single Explorer-copied FileNameW path on Windows', () => {
    expect(
      readClipboardFilePaths(
        deps('win32', {
          FileNameW: fileNameW('C:\\Users\\me\\report.pdf'),
          'Shell IDList Array': shellIdListArray(1)
        })
      )
    ).toEqual(['C:\\Users\\me\\report.pdf'])
  })

  it('leaves Explorer-copied image files to the clipboard image flow', () => {
    expect(
      readClipboardFilePaths(
        deps('win32', {
          FileNameW: fileNameW('C:\\Users\\me\\shot.png'),
          'Shell IDList Array': shellIdListArray(1)
        })
      )
    ).toEqual([])
  })

  it('fails closed when Explorer copied several items', () => {
    expect(
      readClipboardFilePaths(
        deps('win32', {
          FileNameW: fileNameW('C:\\Users\\me\\report.pdf'),
          'Shell IDList Array': shellIdListArray(2)
        })
      )
    ).toEqual([])
  })

  it('parses text/uri-list on Linux, skipping comments and blank lines', () => {
    expect(
      readClipboardFilePaths(
        deps('linux', {
          'text/uri-list': 'file:///home/me/a%20b.txt\r\n# comment\r\n\r\nfile:///home/me/c.txt\r\n'
        })
      )
    ).toEqual(['/home/me/a b.txt', '/home/me/c.txt'])
  })

  it('ignores non-file URIs and unparsable entries', () => {
    expect(
      readClipboardFilePaths(
        deps('linux', { 'text/uri-list': 'https://example.com/x\nnot a uri\n' })
      )
    ).toEqual([])
  })

  it('returns no paths when the clipboard format cannot be read', () => {
    expect(
      readClipboardFilePaths({
        platform: 'darwin',
        readBuffer: () => {
          throw new Error('format unavailable')
        }
      })
    ).toEqual([])
  })
})
