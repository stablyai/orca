import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clipboardReadTextMock, clipboardWriteTextMock } = vi.hoisted(() => ({
  clipboardReadTextMock: vi.fn(),
  clipboardWriteTextMock: vi.fn()
}))

vi.mock('electron', () => ({
  clipboard: {
    readText: clipboardReadTextMock,
    writeText: clipboardWriteTextMock
  }
}))

import { writeClipboardTextAndVerify } from './clipboard-text-write-verify'

describe('writeClipboardTextAndVerify', () => {
  beforeEach(() => {
    clipboardReadTextMock.mockReset()
    clipboardWriteTextMock.mockReset()
  })

  it('writes then accepts a matching standard clipboard read-back', () => {
    clipboardWriteTextMock.mockImplementation((text: string) => {
      clipboardReadTextMock.mockReturnValue(text)
    })

    expect(() => writeClipboardTextAndVerify('tui answer')).not.toThrow()
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('tui answer')
    expect(clipboardReadTextMock).toHaveBeenCalledWith()
  })

  it('accepts multi-line TUI content when read-back is identity-preserving', () => {
    // Primary real-world path: code/agent output almost always contains newlines.
    const multiLine = 'line1\nline2\n  indented\n'
    clipboardWriteTextMock.mockImplementation((text: string) => {
      clipboardReadTextMock.mockReturnValue(text)
    })

    expect(() => writeClipboardTextAndVerify(multiLine)).not.toThrow()
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(multiLine)
    expect(clipboardReadTextMock).toHaveBeenCalledWith()
  })

  it('accepts CRLF multi-line content only when read-back matches exactly', () => {
    // Guard against platforms that normalize line endings between write and read.
    const crlf = 'line1\r\nline2\r\n'
    clipboardWriteTextMock.mockImplementation((text: string) => {
      clipboardReadTextMock.mockReturnValue(text)
    })

    expect(() => writeClipboardTextAndVerify(crlf)).not.toThrow()
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(crlf)
  })

  it('warns (does not throw) when multi-line read-back differs only by line endings', () => {
    // Why: macOS clipboard managers and Windows normalization can alter
    // line endings between write and read. The write succeeded; verify is advisory.
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    clipboardWriteTextMock.mockImplementation(() => {
      // e.g. write LF, OS returns CRLF — advisory warning, not a failure.
      clipboardReadTextMock.mockReturnValue('line1\r\nline2')
    })

    expect(() => writeClipboardTextAndVerify('line1\nline2')).not.toThrow()
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('line1\nline2')
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Clipboard write verification mismatch')
    )
    consoleWarn.mockRestore()
  })

  it('warns (does not throw) when the clipboard read-back does not match', () => {
    // Why: the write succeeded (clipboard.writeText completed); a mismatch is
    // advisory — throwing would make user copy silently fail with no clipboard content.
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    clipboardReadTextMock.mockReturnValue('old clipboard')

    expect(() => writeClipboardTextAndVerify('tui answer')).not.toThrow()
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('tui answer')
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Clipboard write verification mismatch')
    )
    consoleWarn.mockRestore()
  })
})
