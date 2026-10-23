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

  it('writes then accepts a matching standard clipboard read-back', async () => {
    clipboardWriteTextMock.mockImplementation((text: string) => {
      clipboardReadTextMock.mockReturnValue(text)
    })

    await expect(writeClipboardTextAndVerify('tui answer')).resolves.toBeUndefined()
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('tui answer')
    expect(clipboardReadTextMock).toHaveBeenCalledWith()
  })

  it('accepts multi-line TUI content when read-back is identity-preserving', async () => {
    // Primary real-world path: code/agent output almost always contains newlines.
    const multiLine = 'line1\nline2\n  indented\n'
    clipboardWriteTextMock.mockImplementation((text: string) => {
      clipboardReadTextMock.mockReturnValue(text)
    })

    await expect(writeClipboardTextAndVerify(multiLine)).resolves.toBeUndefined()
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(multiLine)
    expect(clipboardReadTextMock).toHaveBeenCalledWith()
  })

  it('accepts CRLF multi-line content only when read-back matches exactly', async () => {
    // Guard against platforms that normalize line endings between write and read.
    const crlf = 'line1\r\nline2\r\n'
    clipboardWriteTextMock.mockImplementation((text: string) => {
      clipboardReadTextMock.mockReturnValue(text)
    })

    await expect(writeClipboardTextAndVerify(crlf)).resolves.toBeUndefined()
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(crlf)
  })

  it('rejects when multi-line read-back differs only by line endings', async () => {
    clipboardWriteTextMock.mockImplementation(() => {
      // e.g. write LF, OS returns CRLF — strict verify must fail rather than lie.
      clipboardReadTextMock.mockReturnValue('line1\r\nline2')
    })

    await expect(writeClipboardTextAndVerify('line1\nline2')).rejects.toThrow(
      CLIPBOARD_WRITE_VERIFICATION_FAILED_ERROR
    )
  })

  it('rejects standard text writes when the clipboard read-back does not match', async () => {
    clipboardReadTextMock.mockReturnValue('old clipboard')

    await expect(writeClipboardTextAndVerify('tui answer')).rejects.toThrow(
      CLIPBOARD_WRITE_VERIFICATION_FAILED_ERROR
    )
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('tui answer')
  })
})
