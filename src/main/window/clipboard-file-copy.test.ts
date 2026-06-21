import { describe, expect, it, vi } from 'vitest'
import { writeFileToClipboard, type ClipboardFileDeps } from './clipboard-file-copy'

function makeDeps(overrides: Partial<ClipboardFileDeps> = {}): ClipboardFileDeps {
  return {
    platform: 'darwin',
    desktop: undefined,
    pathExists: async () => true,
    writeBuffer: vi.fn(),
    runCommand: vi.fn(async () => {}),
    ...overrides
  }
}

describe('writeFileToClipboard', () => {
  it('rejects relative paths without touching the clipboard', async () => {
    const writeBuffer = vi.fn()
    expect(await writeFileToClipboard('relative/file.png', makeDeps({ writeBuffer }))).toEqual({
      ok: false,
      reason: 'invalid-path'
    })
    expect(writeBuffer).not.toHaveBeenCalled()
  })

  it('rejects files that no longer exist', async () => {
    expect(
      await writeFileToClipboard('/repo/gone.png', makeDeps({ pathExists: async () => false }))
    ).toEqual({ ok: false, reason: 'not-found' })
  })

  it('writes a public.file-url buffer on macOS', async () => {
    const writeBuffer = vi.fn()
    const result = await writeFileToClipboard(
      '/repo/a b.png',
      makeDeps({ platform: 'darwin', writeBuffer })
    )
    expect(result).toEqual({ ok: true })
    expect(writeBuffer).toHaveBeenCalledTimes(1)
    const [format, buffer] = writeBuffer.mock.calls[0]
    expect(format).toBe('public.file-url')
    // spaces are percent-encoded into the file URL
    expect(buffer.toString('utf8')).toBe('file:///repo/a%20b.png')
  })

  it('shells out to Set-Clipboard on Windows, escaping quotes', async () => {
    const runCommand = vi.fn(async (_command: string, _args: string[]) => {})
    const result = await writeFileToClipboard(
      "/repo/o'brien.png",
      makeDeps({ platform: 'win32', runCommand })
    )
    expect(result).toEqual({ ok: true })
    const [command, args] = runCommand.mock.calls[0]
    expect(command).toBe('powershell.exe')
    expect(args.join(' ')).toContain("Set-Clipboard -LiteralPath '/repo/o''brien.png'")
  })

  it('reports a failure (never throws) when PowerShell rejects on Windows', async () => {
    const runCommand = vi.fn(async (_command: string, _args: string[]) => {
      throw new Error('powershell.exe not found')
    })
    expect(
      await writeFileToClipboard('/repo/a.png', makeDeps({ platform: 'win32', runCommand }))
    ).toEqual({ ok: false, reason: 'clipboard-command-failed' })
  })

  it('uses the KDE text/uri-list payload on a KDE desktop', async () => {
    const runCommand = vi.fn(async (_command: string, _args: string[], _stdin?: string) => {})
    const result = await writeFileToClipboard(
      '/repo/a b.png',
      makeDeps({ platform: 'linux', desktop: 'KDE', runCommand })
    )
    expect(result).toEqual({ ok: true })
    const [command, args, stdin] = runCommand.mock.calls[0]
    expect(command).toBe('wl-copy')
    expect(args).toContain('text/uri-list')
    expect(stdin).toBe('file:///repo/a%20b.png\r\n')
  })

  it('uses the GNOME copied-files payload on non-KDE desktops', async () => {
    const runCommand = vi.fn(async (_command: string, _args: string[], _stdin?: string) => {})
    await writeFileToClipboard(
      '/repo/a.png',
      makeDeps({ platform: 'linux', desktop: 'GNOME', runCommand })
    )
    const [, args, stdin] = runCommand.mock.calls[0]
    expect(args).toContain('x-special/gnome-copied-files')
    expect(stdin).toBe('copy\nfile:///repo/a.png')
  })

  it('tries each Linux tool and reports unsupported when all fail', async () => {
    const runCommand = vi.fn(async (_command: string, _args: string[]) => {
      throw new Error('command not found')
    })
    expect(
      await writeFileToClipboard('/repo/a.png', makeDeps({ platform: 'linux', runCommand }))
    ).toEqual({ ok: false, reason: 'unsupported-platform' })
    expect(runCommand).toHaveBeenCalledTimes(2) // wl-copy, then xclip
  })

  it('succeeds on Linux when a clipboard tool is available', async () => {
    const runCommand = vi.fn(async (command: string, _args: string[]) => {
      if (command === 'wl-copy') {
        return
      }
      throw new Error('no xclip')
    })
    expect(
      await writeFileToClipboard('/repo/a.png', makeDeps({ platform: 'linux', runCommand }))
    ).toEqual({ ok: true })
    expect(runCommand.mock.calls[0][0]).toBe('wl-copy')
  })
})
