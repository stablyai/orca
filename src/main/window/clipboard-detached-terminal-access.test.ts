import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, clipboardReadText, clipboardWriteText, isDetachedTerminalRenderer } = vi.hoisted(
  () => ({
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    clipboardReadText: vi.fn(() => 'terminal clipboard text'),
    clipboardWriteText: vi.fn(),
    isDetachedTerminalRenderer: vi.fn(() => true)
  })
)

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), commandLine: { getSwitchValue: vi.fn(() => 'x11') } },
  clipboard: {
    readText: clipboardReadText,
    readBuffer: vi.fn(),
    writeText: clipboardWriteText,
    readImage: vi.fn(),
    writeImage: vi.fn(),
    writeBuffer: vi.fn()
  },
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  },
  nativeImage: { createFromBuffer: vi.fn() }
}))

vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))
vi.mock('./detached-terminal-window', () => ({ isDetachedTerminalRenderer }))
vi.mock('./clipboard-remote-file-copy', () => ({
  cleanupExpiredRemoteClipboardFiles: vi.fn(async () => undefined),
  scheduleLegacyRemoteClipboardFileCleanup: vi.fn()
}))

import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'

const companionEvent = {
  sender: {
    id: 43,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///popout.html?surface=terminal'
  }
}

describe('detached terminal clipboard access', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    isDetachedTerminalRenderer.mockReturnValue(true)
    clipboardReadText.mockReturnValue('terminal clipboard text')
    setTrustedClipboardRendererWebContentsId(17)
    registerClipboardHandlers({} as never)
  })

  it('pastes and copies terminal text through a companion window', async () => {
    await expect(handlers.get('clipboard:readText')?.(companionEvent)).resolves.toBe(
      'terminal clipboard text'
    )
    clipboardWriteText.mockImplementation((text: string) => clipboardReadText.mockReturnValue(text))
    await expect(
      handlers.get('clipboard:writeTerminalText')?.(companionEvent, 'terminal selection')
    ).resolves.toBeUndefined()

    expect(clipboardWriteText).toHaveBeenCalledWith('terminal selection')
  })

  it('keeps image, file and selection clipboard APIs to the main renderer', async () => {
    await expect(handlers.get('clipboard:readSelectionText')?.(companionEvent)).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )
    expect(() => handlers.get('clipboard:readFilePaths')?.(companionEvent)).toThrow(
      'Unauthorized clipboard IPC sender'
    )
    expect(() =>
      handlers.get('clipboard:writeImage')?.(companionEvent, 'data:image/png;base64,AAAA')
    ).toThrow('Unauthorized clipboard IPC sender')
  })

  it('rejects a window that is not a detached terminal', async () => {
    isDetachedTerminalRenderer.mockReturnValue(false)

    await expect(handlers.get('clipboard:readText')?.(companionEvent)).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )
    expect(clipboardReadText).not.toHaveBeenCalled()
  })
})
