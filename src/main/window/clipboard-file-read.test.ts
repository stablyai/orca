import { describe, expect, it, vi } from 'vitest'
import {
  CLIPBOARD_FILE_LIST_MAX_BYTES,
  readClipboardFilePaths,
  runClipboardCommandCapture,
  type ClipboardFileReadDeps
} from './clipboard-file-read'

function makeDeps(overrides: Partial<ClipboardFileReadDeps> = {}): ClipboardFileReadDeps {
  return {
    platform: 'darwin',
    desktop: undefined,
    readFormat: vi.fn(() => ''),
    readBuffer: vi.fn(() => Buffer.alloc(0)),
    runCommand: vi.fn(async () => ''),
    ...overrides
  }
}

function filenamesPlist(paths: string[]): string {
  const entries = paths.map((path) => `<string>${path}</string>`).join('\n')
  return `<?xml version="1.0"?><plist><array>${entries}</array></plist>`
}

describe('readClipboardFilePaths', () => {
  it('reads real POSIX paths from the macOS filenames plist', async () => {
    const readFormat = vi.fn((format: string) =>
      format === 'NSFilenamesPboardType'
        ? filenamesPlist(['/Users/me/a.png', '/Users/me/b.pdf'])
        : ''
    )

    expect(await readClipboardFilePaths(makeDeps({ readFormat }))).toEqual([
      '/Users/me/a.png',
      '/Users/me/b.pdf'
    ])
    expect(readFormat).toHaveBeenCalledWith('NSFilenamesPboardType')
  })

  it('XML-unescapes and deduplicates macOS filenames', async () => {
    const readBuffer = vi.fn((format: string) =>
      format === 'NSFilenamesPboardType'
        ? Buffer.from(filenamesPlist(['/Users/me/a &amp; b.png', '/Users/me/a &amp; b.png']))
        : Buffer.alloc(0)
    )

    expect(await readClipboardFilePaths(makeDeps({ readBuffer }))).toEqual(['/Users/me/a & b.png'])
  })

  it('falls back to public.file-url when the macOS plist is absent', async () => {
    const readBuffer = vi.fn((format: string) =>
      format === 'public.file-url'
        ? Buffer.from('file:///Users/me/a%20b.png\0', 'utf8')
        : Buffer.alloc(0)
    )

    expect(await readClipboardFilePaths(makeDeps({ readBuffer }))).toEqual(['/Users/me/a b.png'])
  })

  it('rejects opaque macOS file ids and non-file URLs', async () => {
    const opaque = makeDeps({
      readBuffer: (format) =>
        format === 'public.file-url'
          ? Buffer.from('file:///.file/id=6571367.321897404')
          : Buffer.alloc(0)
    })
    const remote = makeDeps({
      readBuffer: (format) =>
        format === 'public.file-url' ? Buffer.from('https://example.com/x') : Buffer.alloc(0)
    })

    await expect(readClipboardFilePaths(opaque)).resolves.toEqual([])
    await expect(readClipboardFilePaths(remote)).resolves.toEqual([])
  })

  it('reads FileNameW paths directly on Windows', async () => {
    const paths = 'C:\\Users\\me\\a.txt\0C:\\Users\\me\\b.txt\0\0'
    const readBuffer = vi.fn((format: string) =>
      format === 'FileNameW' ? Buffer.from(paths, 'utf16le') : Buffer.alloc(0)
    )

    expect(await readClipboardFilePaths(makeDeps({ platform: 'win32', readBuffer }))).toEqual([
      'C:\\Users\\me\\a.txt',
      'C:\\Users\\me\\b.txt'
    ])
  })

  it('accepts ordinary and extended Windows UNC paths but rejects device namespaces', async () => {
    const paths = [
      '\\\\server\\share\\a.txt',
      '\\\\?\\UNC\\server\\share\\b.txt',
      '\\\\.\\pipe\\orca',
      '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\secret.txt'
    ].join('\0')
    const readBuffer = vi.fn((format: string) =>
      format === 'FileNameW' ? Buffer.from(`${paths}\0\0`, 'utf16le') : Buffer.alloc(0)
    )

    expect(await readClipboardFilePaths(makeDeps({ platform: 'win32', readBuffer }))).toEqual([
      '\\\\server\\share\\a.txt',
      '\\\\?\\UNC\\server\\share\\b.txt'
    ])
  })

  it('parses the GNOME copied-files payload and drops the copy verb', async () => {
    const readBuffer = vi.fn((format: string) =>
      format === 'x-special/gnome-copied-files'
        ? Buffer.from('copy\nfile:///repo/a.png\nfile:///repo/b.png')
        : Buffer.alloc(0)
    )

    expect(
      await readClipboardFilePaths(makeDeps({ platform: 'linux', desktop: 'GNOME', readBuffer }))
    ).toEqual(['/repo/a.png', '/repo/b.png'])
  })

  it('prefers KDE uri-list data and decodes escaped paths', async () => {
    const readBuffer = vi.fn((format: string) =>
      format === 'text/uri-list' ? Buffer.from('file:///repo/a%20b.png\r\n') : Buffer.alloc(0)
    )

    expect(
      await readClipboardFilePaths(makeDeps({ platform: 'linux', desktop: 'KDE', readBuffer }))
    ).toEqual(['/repo/a b.png'])
    expect(readBuffer).not.toHaveBeenCalledWith('x-special/gnome-copied-files')
  })

  it('falls back to bounded Linux clipboard commands', async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === 'wl-paste' && args.includes('text/uri-list')) {
        return 'file:///repo/from-tool.ts'
      }
      throw new Error('format unavailable')
    })

    expect(
      await readClipboardFilePaths(makeDeps({ platform: 'linux', desktop: 'KDE', runCommand }))
    ).toEqual(['/repo/from-tool.ts'])
  })

  it('shares one timeout budget across sequential Linux clipboard probes', async () => {
    vi.useFakeTimers()
    try {
      const runCommand = vi.fn(
        (_command: string, _args: string[], timeoutMs = 750) =>
          new Promise<string>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error('clipboard probe timed out')),
              Math.min(timeoutMs, 750)
            )
          )
      )
      const readPromise = readClipboardFilePaths(
        makeDeps({ platform: 'linux', desktop: 'GNOME', runCommand })
      )

      await vi.advanceTimersByTimeAsync(2_000)

      await expect(readPromise).resolves.toEqual([])
      expect(runCommand).toHaveBeenCalledTimes(3)
      expect(runCommand.mock.calls.map((call) => call[2])).toEqual([2_000, 1_250, 500])
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns no files when reads fail or exceed the buffer cap', async () => {
    const throwing = makeDeps({
      platform: 'linux',
      readBuffer: () => {
        throw new Error('clipboard unavailable')
      },
      runCommand: async () => {
        throw new Error('tool unavailable')
      }
    })
    const oversized = makeDeps({
      readBuffer: () => Buffer.alloc(CLIPBOARD_FILE_LIST_MAX_BYTES + 1, 'x')
    })

    await expect(readClipboardFilePaths(throwing)).resolves.toEqual([])
    await expect(readClipboardFilePaths(oversized)).resolves.toEqual([])
  })
})

describe('runClipboardCommandCapture', () => {
  it('waits for stdout to close before resolving', async () => {
    await expect(
      runClipboardCommandCapture(process.execPath, ['-e', "process.stdout.write('file:///a')"])
    ).resolves.toBe('file:///a')
  })

  it('rejects output beyond the byte cap', async () => {
    await expect(
      runClipboardCommandCapture(process.execPath, [
        '-e',
        `process.stdout.write('x'.repeat(${CLIPBOARD_FILE_LIST_MAX_BYTES + 1}))`
      ])
    ).rejects.toThrow(/exceeded/u)
  })

  it('rejects commands that exceed the timeout', async () => {
    await expect(
      runClipboardCommandCapture(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'])
    ).rejects.toThrow(/timed out/u)
  }, 8_000)
})
