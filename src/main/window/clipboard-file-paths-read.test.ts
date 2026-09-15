import { describe, expect, it, vi } from 'vitest'

import {
  GNOME_COPIED_FILES_FORMAT,
  MACOS_FILENAMES_FORMAT,
  MACOS_FILE_URL_FORMAT,
  URI_LIST_FORMAT,
  WINDOWS_FILE_NAME_FORMAT,
  readClipboardFilePaths,
  type ClipboardFilePathsDeps
} from './clipboard-file-paths-read'

function makeDeps(
  platform: NodeJS.Platform,
  clipboard: Record<string, string | Buffer>
): ClipboardFilePathsDeps {
  return {
    platform,
    read: (format) => {
      const value = clipboard[format]
      return typeof value === 'string' ? value : ''
    },
    readBuffer: (format) => {
      const value = clipboard[format]
      if (value === undefined) {
        return Buffer.alloc(0)
      }
      return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
    }
  }
}

const FINDER_PROPERTY_LIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<array>
\t<string>/Users/me/project/App.tsx</string>
\t<string>/Users/me/notes/spec.md</string>
</array>
</plist>`

describe('readClipboardFilePaths', () => {
  it('reads every file of a macOS multi-file copy from the filenames list', () => {
    // Matches a real Finder copy: the filenames list carries the POSIX paths
    // while public.file-url carries only an inode reference to the first item.
    const paths = readClipboardFilePaths(
      makeDeps('darwin', {
        [MACOS_FILENAMES_FORMAT]: FINDER_PROPERTY_LIST,
        [MACOS_FILE_URL_FORMAT]: 'file:///.file/id=6571367.71479400'
      })
    )
    expect(paths).toEqual(['/Users/me/project/App.tsx', '/Users/me/notes/spec.md'])
  })

  it('pastes nothing rather than an unusable macOS file reference URL', () => {
    expect(
      readClipboardFilePaths(
        makeDeps('darwin', { [MACOS_FILE_URL_FORMAT]: 'file:///.file/id=6571367.71479400' })
      )
    ).toEqual([])
  })

  it('falls back to the macOS file-url flavor when no filenames list is present', () => {
    const paths = readClipboardFilePaths(
      makeDeps('darwin', {
        [MACOS_FILE_URL_FORMAT]: 'file:///Users/me/project/My%20App.tsx'
      })
    )
    expect(paths).toEqual(['/Users/me/project/My App.tsx'])
  })

  it('reads a macOS flavor that only answers as a buffer', () => {
    const paths = readClipboardFilePaths({
      platform: 'darwin',
      read: () => '',
      readBuffer: (format) =>
        format === MACOS_FILE_URL_FORMAT
          ? Buffer.from('file:///Users/me/project/App.tsx', 'utf8')
          : Buffer.alloc(0)
    })
    expect(paths).toEqual(['/Users/me/project/App.tsx'])
  })

  it('reads the Windows Explorer file name flavor as UTF-16', () => {
    const paths = readClipboardFilePaths(
      makeDeps('win32', {
        [WINDOWS_FILE_NAME_FORMAT]: Buffer.from(
          'C:\\Users\\Name\\My Project\\file.txt\0',
          'utf16le'
        )
      })
    )
    expect(paths).toEqual(['C:\\Users\\Name\\My Project\\file.txt'])
  })

  it('prefers the GNOME copied-files payload on Linux', () => {
    const paths = readClipboardFilePaths(
      makeDeps('linux', {
        [GNOME_COPIED_FILES_FORMAT]: 'copy\nfile:///home/me/a.txt\nfile:///home/me/b.txt',
        [URI_LIST_FORMAT]: 'file:///home/me/stale.txt'
      })
    )
    expect(paths).toEqual(['/home/me/a.txt', '/home/me/b.txt'])
  })

  it('falls back to text/uri-list for KDE file managers', () => {
    const paths = readClipboardFilePaths(
      makeDeps('linux', { [URI_LIST_FORMAT]: 'file:///home/me/a.txt\r\n' })
    )
    expect(paths).toEqual(['/home/me/a.txt'])
  })

  it('returns nothing for a text-only clipboard', () => {
    expect(readClipboardFilePaths(makeDeps('darwin', { 'text/plain': 'deploy now' }))).toEqual([])
    expect(readClipboardFilePaths(makeDeps('win32', { 'text/plain': 'deploy now' }))).toEqual([])
    expect(readClipboardFilePaths(makeDeps('linux', { 'text/plain': 'deploy now' }))).toEqual([])
  })

  it('survives a clipboard read that throws', () => {
    const readBuffer = vi.fn(() => {
      throw new Error('clipboard busy')
    })
    expect(
      readClipboardFilePaths({
        platform: 'darwin',
        read: () => {
          throw new Error('clipboard busy')
        },
        readBuffer
      })
    ).toEqual([])
    expect(readBuffer).toHaveBeenCalled()
  })
})
