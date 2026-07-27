import { describe, it, expect, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { readClipboardFilePaths, type ClipboardPasteDeps } from './clipboard-file-paste'

// Why host-valid sample paths: the suite runs on every OS and Node refuses to
// decode file URLs that are not absolute for the HOST platform. The value
// under test is format selection and URI parsing, not URL decoding.
const SAMPLE_A = process.platform === 'win32' ? 'C:\\Users\\ash\\a.txt' : '/Users/ash/a.txt'
const SAMPLE_B = process.platform === 'win32' ? 'C:\\Users\\ash\\b.txt' : '/Users/ash/b.txt'

function makeDeps(overrides: Partial<ClipboardPasteDeps>): ClipboardPasteDeps {
  return {
    platform: 'win32',
    readBuffer: vi.fn(() => Buffer.alloc(0)),
    runCommandForOutput: vi.fn(async () => ''),
    ...overrides
  }
}

describe('readClipboardFilePaths', () => {
  it('parses Windows FileDropList output lines and dedupes', async () => {
    const deps = makeDeps({
      platform: 'win32',
      runCommandForOutput: vi.fn(
        async () => 'C:\\a\\one.txt\r\nC:\\a\\two.txt\r\nC:\\a\\one.txt\r\n'
      )
    })
    expect(await readClipboardFilePaths(deps)).toEqual(['C:\\a\\one.txt', 'C:\\a\\two.txt'])
  })

  it('forces UTF-8 stdout so non-ASCII Windows paths survive, and parses them', async () => {
    const runCommandForOutput = vi.fn(async (_cmd: string, args: string[]) => {
      // Why: PowerShell 5.1 defaults redirected stdout to the OEM code page;
      // without the override every non-ASCII filename mojibakes.
      expect(args.join(' ')).toContain('[Console]::OutputEncoding')
      return 'C:\\docs\\résumé 简历.txt\r\n'
    })
    const deps = makeDeps({ platform: 'win32', runCommandForOutput })
    expect(await readClipboardFilePaths(deps)).toEqual(['C:\\docs\\résumé 简历.txt'])
  })

  it('returns empty when the Windows clipboard has no file drop', async () => {
    const deps = makeDeps({ platform: 'win32', runCommandForOutput: vi.fn(async () => '\r\n') })
    expect(await readClipboardFilePaths(deps)).toEqual([])
  })

  it('never throws when the reader command fails', async () => {
    const deps = makeDeps({
      platform: 'win32',
      runCommandForOutput: vi.fn(async () => {
        throw new Error('powershell missing')
      })
    })
    expect(await readClipboardFilePaths(deps)).toEqual([])
  })

  it('reads a macOS public.file-url entry', async () => {
    const deps = makeDeps({
      platform: 'darwin',
      readBuffer: vi.fn(() => Buffer.from(pathToFileURL(SAMPLE_A).href, 'utf8'))
    })
    expect(await readClipboardFilePaths(deps)).toEqual([SAMPLE_A])
  })

  it('parses gnome-copied-files with a leading verb, falling back to uri-list', async () => {
    const buffers: Record<string, Buffer> = {
      'x-special/gnome-copied-files': Buffer.from(`copy\n${pathToFileURL(SAMPLE_A).href}`, 'utf8'),
      'text/uri-list': Buffer.alloc(0)
    }
    const deps = makeDeps({
      platform: 'linux',
      readBuffer: vi.fn((format: string) => buffers[format] ?? Buffer.alloc(0))
    })
    expect(await readClipboardFilePaths(deps)).toEqual([SAMPLE_A])

    const uriOnly = makeDeps({
      platform: 'linux',
      readBuffer: vi.fn((format: string) =>
        format === 'text/uri-list'
          ? Buffer.from(`# comment\n${pathToFileURL(SAMPLE_B).href}\n`, 'utf8')
          : Buffer.alloc(0)
      )
    })
    expect(await readClipboardFilePaths(uriOnly)).toEqual([SAMPLE_B])
  })

  it('drops relative or malformed entries', async () => {
    const deps = makeDeps({
      platform: 'win32',
      runCommandForOutput: vi.fn(async () => 'not-a-path\r\nC:\\ok.txt')
    })
    expect(await readClipboardFilePaths(deps)).toEqual(['C:\\ok.txt'])
  })
})
