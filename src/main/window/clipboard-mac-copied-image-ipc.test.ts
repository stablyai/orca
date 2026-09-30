import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, clipboardRead, clipboardReadText, readMacClipboardImageFileAsPng, saveBuffer } =
  vi.hoisted(() => ({
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    clipboardRead: vi.fn((format: string): string =>
      format === 'public.file-url' ? 'file:///Users/u/Desktop/Screenshot.png' : '<plist/>'
    ),
    clipboardReadText: vi.fn(() => 'Screenshot.png'),
    readMacClipboardImageFileAsPng: vi.fn(),
    saveBuffer: vi.fn(async () => '/var/tmp/orca-paste-1.png')
  }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  clipboard: { read: clipboardRead, readText: clipboardReadText, readImage: vi.fn() },
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  },
  nativeImage: { createFromBuffer: vi.fn() }
}))
vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))
vi.mock('./clipboard-mac-image-file', () => ({
  isMacClipboardFileUrl: (url: string) => url.startsWith('file://'),
  readMacClipboardImageFileAsPng
}))
vi.mock('./clipboard-image-temp-file', () => ({ saveClipboardImageBufferAsTempFile: saveBuffer }))
vi.mock('./clipboard-remote-file-copy', () => ({
  cleanupExpiredRemoteClipboardFiles: vi.fn(async () => undefined),
  scheduleLegacyRemoteClipboardFileCleanup: vi.fn(),
  writeRemoteFileToClipboard: vi.fn()
}))

import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'

const mainEvent = {
  sender: { id: 7, isDestroyed: () => false, getType: () => 'window', getURL: () => '' }
}

describe('clipboard:saveCopiedImageFileAsTempFile', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    setTrustedClipboardRendererWebContentsId(7)
    registerClipboardHandlers({} as never)
  })

  it('saves a Finder-copied image file for the paste target on macOS', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const png = Buffer.from([1, 2, 3])
    readMacClipboardImageFileAsPng.mockResolvedValue(png)
    try {
      await expect(
        handlers.get('clipboard:saveCopiedImageFileAsTempFile')?.(mainEvent, {
          connectionId: 'ssh-1'
        })
      ).resolves.toBe('/var/tmp/orca-paste-1.png')
      expect(readMacClipboardImageFileAsPng).toHaveBeenCalledWith(
        {
          fileUrl: 'file:///Users/u/Desktop/Screenshot.png',
          filenamesPlist: '<plist/>',
          text: 'Screenshot.png'
        },
        expect.any(Object)
      )
      expect(saveBuffer).toHaveBeenCalledWith(png, { connectionId: 'ssh-1' })
    } finally {
      platformSpy.mockRestore()
    }
  })

  it.each(['win32', 'linux'] as const)('is a no-op on %s', async (platform) => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    try {
      await expect(
        handlers.get('clipboard:saveCopiedImageFileAsTempFile')?.(mainEvent)
      ).resolves.toBeNull()
      expect(clipboardRead).not.toHaveBeenCalled()
      expect(readMacClipboardImageFileAsPng).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('skips the text read when no file URL is on the clipboard', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    clipboardRead.mockReturnValueOnce('')
    try {
      await expect(
        handlers.get('clipboard:saveCopiedImageFileAsTempFile')?.(mainEvent)
      ).resolves.toBeNull()
      expect(clipboardReadText).not.toHaveBeenCalled()
      expect(readMacClipboardImageFileAsPng).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })
})
