import { describe, expect, it, vi } from 'vitest'
import { readClipboardFilePaths, type ClipboardFileReadDeps } from './clipboard-file-read'

function makeDeps(overrides: Partial<ClipboardFileReadDeps> = {}): ClipboardFileReadDeps {
  return {
    platform: 'darwin',
    desktop: undefined,
    readFormat: vi.fn(() => ''),
    readBuffer: vi.fn(() => Buffer.from('')),
    runCommand: vi.fn(async () => ''),
    ...overrides
  }
}

const PLIST_HEADER = '<?xml version="1.0" encoding="UTF-8"?>'

function filenamesPlist(paths: string[]): string {
  const entries = paths.map((path) => `\t<string>${path}</string>`).join('\n')
  return `${PLIST_HEADER}\n<plist version="1.0">\n<array>\n${entries}\n</array>\n</plist>`
}

describe('readClipboardFilePaths', () => {
  it('reads real POSIX paths from the macOS NSFilenamesPboardType plist', async () => {
    const readFormat = vi.fn((format: string) =>
      format === 'NSFilenamesPboardType'
        ? filenamesPlist(['/Users/me/a.png', '/Users/me/b.pdf'])
        : ''
    )
    expect(await readClipboardFilePaths(makeDeps({ platform: 'darwin', readFormat }))).toEqual([
      '/Users/me/a.png',
      '/Users/me/b.pdf'
    ])
    // Prefer the plist over public.file-url, which can be an opaque reference.
    expect(readFormat).toHaveBeenCalledWith('NSFilenamesPboardType')
  })

  it('XML-unescapes filenames from the plist', async () => {
    const readFormat = vi.fn((format: string) =>
      format === 'NSFilenamesPboardType' ? filenamesPlist(['/Users/me/a &amp; b.png']) : ''
    )
    expect(await readClipboardFilePaths(makeDeps({ platform: 'darwin', readFormat }))).toEqual([
      '/Users/me/a & b.png'
    ])
  })

  it('falls back to a macOS public.file-url path URL when the plist is absent', async () => {
    const readFormat = vi.fn((format: string) =>
      format === 'public.file-url' ? 'file:///Users/me/a%20b.png' : ''
    )
    expect(await readClipboardFilePaths(makeDeps({ platform: 'darwin', readFormat }))).toEqual([
      '/Users/me/a b.png'
    ])
  })

  it('returns [] for an unresolvable macOS /.file/ reference with no plist', async () => {
    const readFormat = vi.fn((format: string) =>
      format === 'public.file-url' ? 'file:///.file/id=6571367.321897404' : ''
    )
    expect(await readClipboardFilePaths(makeDeps({ platform: 'darwin', readFormat }))).toEqual([])
  })

  it('returns [] on macOS when no file reference is on the clipboard', async () => {
    expect(
      await readClipboardFilePaths(makeDeps({ platform: 'darwin', readFormat: () => '' }))
    ).toEqual([])
  })

  it('never throws on macOS when the clipboard read fails', async () => {
    const readFormat = vi.fn(() => {
      throw new Error('clipboard unavailable')
    })
    await expect(
      readClipboardFilePaths(makeDeps({ platform: 'darwin', readFormat }))
    ).resolves.toEqual([])
  })

  it('returns [] on macOS for a non-file URL', async () => {
    const readFormat = vi.fn((format: string) =>
      format === 'public.file-url' ? 'https://example.com/x' : ''
    )
    expect(await readClipboardFilePaths(makeDeps({ platform: 'darwin', readFormat }))).toEqual([])
  })

  it('reads newline-separated FileDropList paths via PowerShell on Windows', async () => {
    const runCommand = vi.fn(
      async (_command: string, _args: string[]) =>
        'C:\\Users\\me\\a.txt\r\nC:\\Users\\me\\b.txt\r\n'
    )
    const result = await readClipboardFilePaths(makeDeps({ platform: 'win32', runCommand }))
    expect(result).toEqual(['C:\\Users\\me\\a.txt', 'C:\\Users\\me\\b.txt'])
    const [command, args] = runCommand.mock.calls[0]
    expect(command).toBe('powershell.exe')
    expect(args.join(' ')).toContain('Get-Clipboard -Format FileDropList')
  })

  it('returns [] on Windows when the clipboard holds no files', async () => {
    expect(
      await readClipboardFilePaths(makeDeps({ platform: 'win32', runCommand: async () => '' }))
    ).toEqual([])
  })

  it('never throws on Windows when PowerShell fails', async () => {
    const runCommand = vi.fn(async () => {
      throw new Error('powershell.exe not found')
    })
    await expect(
      readClipboardFilePaths(makeDeps({ platform: 'win32', runCommand }))
    ).resolves.toEqual([])
  })

  it('parses the GNOME copied-files payload and drops the copy verb', async () => {
    const readBuffer = vi.fn((format: string) =>
      format === 'x-special/gnome-copied-files'
        ? Buffer.from('copy\nfile:///repo/a.png\nfile:///repo/b.png')
        : Buffer.from('')
    )
    expect(
      await readClipboardFilePaths(makeDeps({ platform: 'linux', desktop: 'GNOME', readBuffer }))
    ).toEqual(['/repo/a.png', '/repo/b.png'])
  })

  it('parses the KDE text/uri-list payload', async () => {
    const readBuffer = vi.fn((format: string) =>
      format === 'text/uri-list' ? Buffer.from('file:///repo/a%20b.png\r\n') : Buffer.from('')
    )
    expect(
      await readClipboardFilePaths(makeDeps({ platform: 'linux', desktop: 'KDE', readBuffer }))
    ).toEqual(['/repo/a b.png'])
  })

  it('falls back to the other format when the preferred one is empty on Linux', async () => {
    const readBuffer = vi.fn((format: string) =>
      format === 'text/uri-list' ? Buffer.from('file:///repo/only.png') : Buffer.from('')
    )
    expect(
      await readClipboardFilePaths(makeDeps({ platform: 'linux', desktop: 'GNOME', readBuffer }))
    ).toEqual(['/repo/only.png'])
  })

  it('never throws on Linux when every clipboard read fails', async () => {
    const readBuffer = vi.fn(() => {
      throw new Error('no clipboard tool')
    })
    await expect(
      readClipboardFilePaths(makeDeps({ platform: 'linux', readBuffer }))
    ).resolves.toEqual([])
  })
})
