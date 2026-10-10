import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, clipboardReadText } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  clipboardReadText: vi.fn(() => 'clipboard secret')
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  clipboard: {
    readText: clipboardReadText,
    readBuffer: vi.fn(),
    writeText: vi.fn(),
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
vi.mock('./clipboard-remote-file-copy', () => ({
  cleanupExpiredRemoteClipboardFiles: vi.fn(async () => undefined),
  scheduleLegacyRemoteClipboardFileCleanup: vi.fn(),
  writeRemoteFileToClipboard: vi.fn()
}))

import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'

const fileWindowEvent = {
  sender: {
    id: 17,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///tmp/any-local-page.html'
  }
}

describe('clipboard IPC with no pinned main renderer', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    setTrustedClipboardRendererWebContentsId(null)
    registerClipboardHandlers({} as never)
  })

  it('refuses a file:// window in packaged builds instead of trusting the URL scheme', async () => {
    await expect(handlers.get('clipboard:readText')?.(fileWindowEvent)).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )
    expect(() => handlers.get('clipboard:writeFile')?.(fileWindowEvent, '/tmp/file.txt')).toThrow(
      'Unauthorized clipboard IPC sender'
    )
    expect(clipboardReadText).not.toHaveBeenCalled()
  })

  it('trusts the same window once it is pinned as the main renderer', async () => {
    setTrustedClipboardRendererWebContentsId(17)
    await expect(handlers.get('clipboard:readText')?.(fileWindowEvent)).resolves.toBe(
      'clipboard secret'
    )
  })
})
