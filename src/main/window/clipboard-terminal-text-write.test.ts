import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clipboardReadTextMock, clipboardWriteTextMock, runProcessMock } = vi.hoisted(() => ({
  clipboardReadTextMock: vi.fn(),
  clipboardWriteTextMock: vi.fn(),
  runProcessMock: vi.fn()
}))

vi.mock('electron', () => ({
  clipboard: {
    readText: clipboardReadTextMock,
    writeText: clipboardWriteTextMock
  }
}))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock
}))

import { writeTerminalClipboardText } from './clipboard-terminal-text-write'

const WAYLAND = { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-1' } } as const

function wlPasteResult(stdout: string, overrides: Record<string, unknown> = {}) {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false, ...overrides }
}

describe('writeTerminalClipboardText', () => {
  beforeEach(() => {
    clipboardReadTextMock.mockReset()
    clipboardWriteTextMock.mockReset()
    runProcessMock.mockReset()
    clipboardWriteTextMock.mockImplementation((text: string) => {
      clipboardReadTextMock.mockReturnValue(text)
    })
  })

  it('skips the write when the Wayland clipboard already holds the same text', async () => {
    // e.g. Claude Code ran wl-copy, then emitted OSC 52 with the same text.
    runProcessMock.mockResolvedValue(wlPasteResult('line1\nline2\n'))

    await writeTerminalClipboardText('line1\nline2\n', WAYLAND)

    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'wl-paste', args: ['--no-newline'] })
    )
    expect(clipboardWriteTextMock).not.toHaveBeenCalled()
  })

  it('writes when the Wayland clipboard holds different text', async () => {
    // e.g. OSC 52 from an SSH session, where nothing touched the local clipboard.
    runProcessMock.mockResolvedValue(wlPasteResult('older copy'))

    await writeTerminalClipboardText('remote text', WAYLAND)

    expect(clipboardWriteTextMock).toHaveBeenCalledWith('remote text')
  })

  it.each([
    ['exits non-zero', wlPasteResult('', { code: 1 })],
    ['times out', wlPasteResult('same', { code: null, timedOut: true })],
    ['output is truncated', wlPasteResult('same', { outputTruncated: true })]
  ])('writes when wl-paste %s', async (_label, result) => {
    runProcessMock.mockResolvedValue(result)

    await writeTerminalClipboardText('same', WAYLAND)

    expect(clipboardWriteTextMock).toHaveBeenCalledWith('same')
  })

  it('writes when wl-paste cannot be started', async () => {
    runProcessMock.mockRejectedValue(
      Object.assign(new Error('spawn wl-paste ENOENT'), { code: 'ENOENT' })
    )

    await writeTerminalClipboardText('text', WAYLAND)

    expect(clipboardWriteTextMock).toHaveBeenCalledWith('text')
  })

  it.each([
    ['macOS', { platform: 'darwin', env: { WAYLAND_DISPLAY: 'wayland-1' } }],
    ['Windows', { platform: 'win32', env: {} }],
    ['Linux on X11', { platform: 'linux', env: { DISPLAY: ':0' } }]
  ] as const)('writes directly without reading the clipboard on %s', async (_label, host) => {
    await writeTerminalClipboardText('text', host)

    expect(runProcessMock).not.toHaveBeenCalled()
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('text')
  })

  it('still rejects when the write cannot be verified', async () => {
    runProcessMock.mockResolvedValue(wlPasteResult('older copy'))
    clipboardWriteTextMock.mockImplementation(() => {
      clipboardReadTextMock.mockReturnValue('older copy')
    })

    await expect(writeTerminalClipboardText('text', WAYLAND)).rejects.toThrow(
      'Clipboard write verification failed'
    )
  })
})
