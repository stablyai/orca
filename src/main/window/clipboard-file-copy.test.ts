import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { writeFileToClipboard, type ClipboardFileDeps } from './clipboard-file-copy'

function exited(code: number | null): ProcessResult {
  return { code, signal: null, stdout: '', stderr: '', timedOut: false }
}

function makeDeps(overrides: Partial<ClipboardFileDeps> = {}): ClipboardFileDeps {
  return {
    platform: 'darwin',
    desktop: undefined,
    resolveFilePath: async (path) => ({ ok: true, path }),
    writeBuffer: vi.fn(),
    runProcess: vi.fn(async () => exited(0)),
    ...overrides
  }
}

describe('writeFileToClipboard', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

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
      await writeFileToClipboard(
        '/repo/gone.png',
        makeDeps({ resolveFilePath: async () => ({ ok: false, reason: 'not-found' }) })
      )
    ).toEqual({ ok: false, reason: 'not-found' })
  })

  it('rejects files outside authorized local roots', async () => {
    expect(
      await writeFileToClipboard(
        '/etc/passwd',
        makeDeps({ resolveFilePath: async () => ({ ok: false, reason: 'access-denied' }) })
      )
    ).toEqual({ ok: false, reason: 'access-denied' })
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

  it('reports a failure when the macOS clipboard write throws', async () => {
    const writeBuffer = vi.fn(() => {
      throw new Error('clipboard unavailable')
    })
    await expect(
      writeFileToClipboard('/repo/a.png', makeDeps({ platform: 'darwin', writeBuffer }))
    ).resolves.toEqual({ ok: false, reason: 'clipboard-write-failed' })
  })

  it('uses the authorized resolved path for clipboard payloads', async () => {
    const writeBuffer = vi.fn()
    await writeFileToClipboard(
      '/repo/link.png',
      makeDeps({
        platform: 'darwin',
        resolveFilePath: async () => ({ ok: true, path: '/repo/actual.png' }),
        writeBuffer
      })
    )
    expect(writeBuffer).toHaveBeenCalledWith(
      'public.file-url',
      Buffer.from('file:///repo/actual.png', 'utf8')
    )
  })

  it('copies on Windows with Set-Clipboard, passing the path as data, never as script', async () => {
    vi.stubEnv('SystemRoot', 'D:\\Win')
    vi.stubEnv('ORCA_TEST_INHERITED', 'kept')
    const runProcess = vi.fn(async (_spec: ProcessSpec) => exited(0))
    const result = await writeFileToClipboard(
      "/repo/o'brien $(calc).png",
      makeDeps({ platform: 'win32', runProcess })
    )
    expect(result).toEqual({ ok: true })
    const spec = runProcess.mock.calls[0][0]
    // Absolute System32 path, never a bare name resolved on PATH.
    expect(spec.program).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(spec.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Set-Clipboard -LiteralPath $env:ORCA_CLIPBOARD_FILE'
    ])
    expect(spec.env?.ORCA_CLIPBOARD_FILE).toBe("/repo/o'brien $(calc).png")
    // PowerShell cannot start without the inherited environment.
    expect(spec.env?.ORCA_TEST_INHERITED).toBe('kept')
  })

  it.each([
    ['exits non-zero', async () => exited(1)],
    ['times out', async () => ({ ...exited(null), timedOut: true })],
    [
      'cannot start',
      async () => {
        throw new Error('spawn ENOENT')
      }
    ]
  ])('reports a Windows copy whose PowerShell %s as failed', async (_, run) => {
    expect(
      await writeFileToClipboard(
        '/repo/a.png',
        makeDeps({ platform: 'win32', runProcess: vi.fn(run) })
      )
    ).toEqual({ ok: false, reason: 'clipboard-command-failed' })
  })

  it('uses the KDE text/uri-list payload on a KDE desktop', async () => {
    const runProcess = vi.fn(async (_spec: ProcessSpec) => exited(0))
    const result = await writeFileToClipboard(
      '/repo/a b.png',
      makeDeps({ platform: 'linux', desktop: 'KDE', runProcess })
    )
    expect(result).toEqual({ ok: true })
    const spec = runProcess.mock.calls[0][0]
    expect(spec.program).toBe('wl-copy')
    expect(spec.args).toContain('text/uri-list')
    expect(spec.input).toBe('file:///repo/a%20b.png\r\n')
  })

  it('uses the GNOME copied-files payload on non-KDE desktops', async () => {
    const runProcess = vi.fn(async (_spec: ProcessSpec) => exited(0))
    await writeFileToClipboard(
      '/repo/a.png',
      makeDeps({ platform: 'linux', desktop: 'GNOME', runProcess })
    )
    const spec = runProcess.mock.calls[0][0]
    expect(spec.args).toContain('x-special/gnome-copied-files')
    expect(spec.input).toBe('copy\nfile:///repo/a.png')
  })

  it('ignores helper stdout/stderr so a forked selection owner cannot hold the run open', async () => {
    const runProcess = vi.fn(async (_spec: ProcessSpec) => exited(0))
    await writeFileToClipboard('/repo/a.png', makeDeps({ platform: 'linux', runProcess }))
    expect(runProcess.mock.calls[0][0].stdio).toEqual(['pipe', 'ignore', 'ignore'])
  })

  it('tries each Linux tool and reports unsupported when all fail', async () => {
    const runProcess = vi
      .fn(async (_spec: ProcessSpec): Promise<ProcessResult> => exited(1))
      .mockRejectedValueOnce(new Error('spawn wl-copy ENOENT'))
    expect(
      await writeFileToClipboard('/repo/a.png', makeDeps({ platform: 'linux', runProcess }))
    ).toEqual({ ok: false, reason: 'unsupported-platform' })
    expect(runProcess.mock.calls.map(([spec]) => spec.program)).toEqual(['wl-copy', 'xclip'])
  })

  it('falls back to xclip when wl-copy fails', async () => {
    const runProcess = vi.fn(async (spec: ProcessSpec) =>
      spec.program === 'xclip' ? exited(0) : exited(1)
    )
    expect(
      await writeFileToClipboard('/repo/a.png', makeDeps({ platform: 'linux', runProcess }))
    ).toEqual({ ok: true })
    expect(runProcess).toHaveBeenCalledTimes(2)
  })
})
