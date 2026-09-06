import { describe, expect, it, vi } from 'vitest'
import * as Clipboard from 'expo-clipboard'
import type * as MobileClipboardImageModule from './mobile-clipboard-image'
import { saveMobileClipboardImageAsTempFile } from './mobile-clipboard-image'
import { defaultMobileTerminalPastePayload } from './default-mobile-terminal-paste-payload'

vi.mock('expo-clipboard', () => ({
  getStringAsync: vi.fn(),
  getImageAsync: vi.fn()
}))
vi.mock('./mobile-clipboard-image', async (loadOriginal) => {
  const original = await loadOriginal<typeof MobileClipboardImageModule>()
  return {
    ...original,
    prepareMobileClipboardImageBase64: vi.fn(),
    saveMobileClipboardImageAsTempFile: vi.fn()
  }
})
vi.mock('./mobile-clipboard-image-resizer', () => ({
  resizeMobileClipboardImage: vi.fn()
}))

const client = { sendRequest: vi.fn() } as never

describe('default mobile terminal paste payload', () => {
  it('wraps native clipboard text for bracketed paste', async () => {
    vi.mocked(Clipboard.getStringAsync).mockResolvedValue('hello')

    await expect(
      defaultMobileTerminalPastePayload({
        client,
        connectionId: async () => null,
        modes: {
          bracketedPasteMode: true,
          altScreen: false,
          mouseTrackingMode: 'none',
          sgrMouseMode: false,
          sgrMousePixelsMode: false
        }
      })
    ).resolves.toBe('\x1b[200~hello\x1b[201~')
    expect(Clipboard.getImageAsync).not.toHaveBeenCalled()
  })

  it('returns null when the native clipboard has no text or image', async () => {
    vi.mocked(Clipboard.getStringAsync).mockResolvedValue('')
    vi.mocked(Clipboard.getImageAsync).mockResolvedValue(null)

    await expect(
      defaultMobileTerminalPastePayload({
        client,
        connectionId: async () => null,
        modes: undefined
      })
    ).resolves.toBeNull()
    expect(saveMobileClipboardImageAsTempFile).not.toHaveBeenCalled()
  })
})
