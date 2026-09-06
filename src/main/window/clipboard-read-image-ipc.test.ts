import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clipboardReadImage, handlers, removeHandler } = vi.hoisted(() => ({
  clipboardReadImage: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  clipboard: {
    readBuffer: vi.fn(),
    readImage: clipboardReadImage,
    readText: vi.fn(),
    writeBuffer: vi.fn(),
    writeImage: vi.fn(),
    writeText: vi.fn()
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => {
      removeHandler(channel)
      handlers.delete(channel)
    }
  },
  nativeImage: { createFromBuffer: vi.fn() }
}))

vi.mock('./clipboard-remote-file-copy', () => ({
  cleanupExpiredRemoteClipboardFiles: vi.fn(async () => undefined),
  scheduleLegacyRemoteClipboardFileCleanup: vi.fn(),
  writeRemoteFileToClipboard: vi.fn()
}))
vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))

import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'

function clipboardEvent(id: number) {
  return {
    sender: {
      getType: () => 'window',
      getURL: () => 'file:///orca/index.html',
      id,
      isDestroyed: () => false
    }
  }
}

describe('clipboard read-image IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    setTrustedClipboardRendererWebContentsId(17)
    registerClipboardHandlers({} as never)
  })

  it('replaces the handler and rejects untrusted renderers', async () => {
    expect(removeHandler).toHaveBeenCalledWith('clipboard:readImage')
    await expect(handlers.get('clipboard:readImage')?.(clipboardEvent(18))).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )
  })

  it('returns validated PNG bytes to the trusted renderer', async () => {
    const png = Buffer.from([0, 1, 2, 3])
    clipboardReadImage.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })

    const result = (await handlers.get('clipboard:readImage')?.(clipboardEvent(17))) as {
      content: ArrayBuffer
      mimeType: string
    }
    expect(result.mimeType).toBe('image/png')
    expect(Buffer.from(result.content)).toEqual(png)
  })
})
