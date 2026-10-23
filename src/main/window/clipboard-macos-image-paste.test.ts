import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
} from '../../shared/clipboard-image'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  read: vi.fn(),
  has: vi.fn(),
  createFromBuffer: vi.fn(),
  toPNG: vi.fn(),
  writeFile: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  clipboard: { read: mocks.read, has: mocks.has },
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler)
  },
  nativeImage: {
    createFromBuffer: mocks.createFromBuffer,
    createEmpty: () => ({ isEmpty: () => true })
  }
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return { ...fs, default: { ...fs, writeFile: mocks.writeFile } }
})
vi.mock('../persistence', () => ({ Store: vi.fn() }))
vi.mock('./clipboard-remote-file-copy', () => ({
  cleanupExpiredRemoteClipboardFiles: vi.fn(),
  scheduleLegacyRemoteClipboardFileCleanup: vi.fn()
}))
vi.mock('./native-chat-paste-files', () => ({
  restoreNativeChatPastes: vi.fn(),
  nativeChatPasteFolder: () => '/tmp/native-chat-pastes'
}))
vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))

import { Store } from '../persistence'
import { nativeClipboardFormat } from './clipboard-formats'
import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'

const event = {
  sender: {
    id: 17,
    getType: () => 'window',
    getURL: () => 'file:///orca/index.html',
    isDestroyed: () => false
  }
}
const PNG = Buffer.from([1, 2, 3])
function invoke(channel: string): unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`Missing clipboard handler: ${channel}`)
  }
  return handler(event)
}
function setClipboard(format: string, bytes: Uint8Array): void {
  const type = format.includes('/') ? format : nativeClipboardFormat(format)
  mocks.read.mockResolvedValue([
    { types: [type], getType: async () => new Blob([new Uint8Array(bytes)]) }
  ])
  mocks.has.mockImplementation(async (candidate: string) => candidate === type)
}
function decodedImage(width = 32, height = 24) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: mocks.toPNG,
    toDataURL: () => 'data:image/png;base64,PREVIEW'
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.handlers.clear()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  installFakeAppEnvironment({ getPath: () => '/tmp' })
  mocks.createFromBuffer.mockReturnValue(decodedImage())
  mocks.toPNG.mockReturnValue(PNG)
  mocks.writeFile.mockResolvedValue(undefined)
  setTrustedClipboardRendererWebContentsId(17)
  registerClipboardHandlers(new Store())
})
afterEach(() => {
  vi.restoreAllMocks()
  setTrustedClipboardRendererWebContentsId(null)
})

describe('asynchronous macOS image clipboard', () => {
  it.each(['image/png', 'public.png', 'public.tiff'])(
    'saves and previews %s data',
    async (format) => {
      setClipboard(format, PNG)
      await expect(invoke('clipboard:hasImage')).resolves.toBe(true)
      expect(mocks.createFromBuffer).not.toHaveBeenCalled()
      const savedPath = await invoke('clipboard:saveImageAsTempFile')
      expect(savedPath).toMatch(/orca-paste-.+\.png$/)
      expect(mocks.writeFile).toHaveBeenCalledWith(savedPath, PNG)
      await expect(invoke('clipboard:readImageThumbnail')).resolves.toEqual({
        dataUrl: 'data:image/png;base64,PREVIEW',
        width: 32,
        height: 24
      })
    }
  )
  it('does not decode a file URL without image data', async () => {
    setClipboard('public.file-url', Buffer.from('file:///tmp/shot.png'))
    await expect(invoke('clipboard:hasImage')).resolves.toBe(false)
    await expect(invoke('clipboard:saveImageAsTempFile')).resolves.toBeNull()
    expect(mocks.createFromBuffer).not.toHaveBeenCalled()
  })
  it('ignores malformed native image data', async () => {
    setClipboard('public.png', Buffer.from('malformed'))
    mocks.createFromBuffer.mockReturnValue({ isEmpty: () => true })
    await expect(invoke('clipboard:saveImageAsTempFile')).resolves.toBeNull()
    await expect(invoke('clipboard:readImageThumbnail')).resolves.toBeNull()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
  it('decodes JPEG bytes stored under the native PNG type', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    setClipboard('public.png', jpeg)
    await expect(invoke('clipboard:saveImageAsTempFile')).resolves.toMatch(/\.png$/)
    expect(mocks.createFromBuffer).toHaveBeenCalledWith(jpeg)
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.any(String), PNG)
  })
  it.each([
    Buffer.alloc(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1),
    Buffer.from('ffd8ffc00011081770177003011100021100031100ffd9', 'hex')
  ])('rejects oversized source data before native decoding', async (bytes) => {
    setClipboard('public.png', bytes)
    await expect(invoke('clipboard:saveImageAsTempFile')).rejects.toThrow(
      'Clipboard image is too large'
    )
    await expect(invoke('clipboard:readImageThumbnail')).resolves.toBeNull()
    expect(mocks.createFromBuffer).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
  it('rejects oversized decoded dimensions', async () => {
    setClipboard('public.png', PNG)
    mocks.createFromBuffer.mockReturnValue(decodedImage(CLIPBOARD_IMAGE_MAX_PIXELS + 1, 1))
    await expect(invoke('clipboard:saveImageAsTempFile')).rejects.toThrow(
      'Clipboard image is too large'
    )
    expect(mocks.toPNG).not.toHaveBeenCalled()
  })
  it('rejects oversized PNG output', async () => {
    setClipboard('public.png', PNG)
    mocks.toPNG.mockReturnValue(Buffer.alloc(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1))
    await expect(invoke('clipboard:saveImageAsTempFile')).rejects.toThrow(
      'Clipboard image is too large'
    )
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
  it('checks the renderer before reading clipboard data', async () => {
    setTrustedClipboardRendererWebContentsId(42)
    for (const channel of [
      'clipboard:hasImage',
      'clipboard:readImageThumbnail',
      'clipboard:saveImageAsTempFile'
    ]) {
      await expect(invoke(channel)).rejects.toThrow('Unauthorized clipboard IPC sender')
    }
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.has).not.toHaveBeenCalled()
  })
})
