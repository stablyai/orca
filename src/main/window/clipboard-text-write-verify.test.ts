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

import {
  CLIPBOARD_WRITE_VERIFICATION_FAILED_ERROR,
  writeClipboardTextAndVerify
} from './clipboard-text-write-verify'

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

  it('rejects when multi-line read-back differs only by line endings', () => {
    clipboardWriteTextMock.mockImplementation(() => {
      // e.g. write LF, OS returns CRLF — strict verify must fail rather than lie.
      clipboardReadTextMock.mockReturnValue('line1\r\nline2')
    })

    expect(() => writeClipboardTextAndVerify('line1\nline2')).toThrow(
      CLIPBOARD_WRITE_VERIFICATION_FAILED_ERROR
    )
  })

  it('rejects standard text writes when the clipboard read-back does not match', () => {
    clipboardReadTextMock.mockReturnValue('old clipboard')

    expect(() => writeClipboardTextAndVerify('tui answer')).toThrow(
      CLIPBOARD_WRITE_VERIFICATION_FAILED_ERROR
    )
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('tui answer')
  })
})
