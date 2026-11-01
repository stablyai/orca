import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readTextMock, readMock, readBufferMock } = vi.hoisted(() => ({
  readTextMock: vi.fn(),
  readMock: vi.fn(),
  readBufferMock: vi.fn()
}))

vi.mock('electron', () => ({
  clipboard: {
    readText: readTextMock,
    read: readMock,
    readBuffer: readBufferMock
  }
}))

import { readClipboardText } from './clipboard-read-text'

describe('readClipboardText', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    readBufferMock.mockReturnValue(Buffer.from(''))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('returns clipboard.readText() directly when text is present', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    readTextMock.mockReturnValue('https://example.com')

    expect(readClipboardText()).toBe('https://example.com')
    expect(readTextMock).toHaveBeenCalledWith()
    expect(readMock).not.toHaveBeenCalled()
  })

  it('falls back to public.plain-text on darwin when readText is empty (Universal Clipboard)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    readTextMock.mockReturnValue('')
    readMock.mockImplementation((type: string) => {
      if (type === 'public.plain-text') {
        return 'https://handoff.apple.com'
      }
      return ''
    })

    expect(readClipboardText()).toBe('https://handoff.apple.com')
    expect(readMock).toHaveBeenCalledWith('public.plain-text')
  })

  it('falls back to public.url on darwin when readText and public.plain-text are empty', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    readTextMock.mockReturnValue('')
    readMock.mockImplementation((type: string) => {
      if (type === 'public.url') {
        return 'https://ios-safari-url.com'
      }
      return ''
    })

    expect(readClipboardText()).toBe('https://ios-safari-url.com')
    expect(readMock).toHaveBeenCalledWith('public.url')
  })

  it('falls back to buffer if read() returns empty string but readBuffer() has data', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    readTextMock.mockReturnValue('')
    readMock.mockReturnValue('')
    readBufferMock.mockImplementation((type: string) => {
      if (type === 'public.url') {
        return Buffer.from('https://buffered-url.org')
      }
      return Buffer.from('')
    })

    expect(readClipboardText()).toBe('https://buffered-url.org')
    expect(readBufferMock).toHaveBeenCalledWith('public.url')
  })

  it('does not attempt darwin fallbacks on non-darwin platforms when readText is empty', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    readTextMock.mockReturnValue('')

    expect(readClipboardText()).toBe('')
    expect(readMock).not.toHaveBeenCalled()
  })

  it('does not attempt darwin fallbacks for selection clipboard', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    readTextMock.mockReturnValue('')

    expect(readClipboardText('selection')).toBe('')
    expect(readMock).not.toHaveBeenCalled()
  })
})
