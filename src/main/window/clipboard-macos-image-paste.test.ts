import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
} from '../../shared/clipboard-image'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  has: vi.fn(),
  readImage: vi.fn(),
  readBuffer: vi.fn(),
  createFromBuffer: vi.fn(),
  toPNG: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  clipboard: {
    availableFormats: () => ['text/uri-list'],
    has: mocks.has,
    readImage: mocks.readImage,
    readBuffer: mocks.readBuffer
  },
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler)
  },
  nativeImage: { createFromBuffer: mocks.createFromBuffer }
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
  sweepExpiredNativeChatPastes: vi.fn(),
  nativeChatPasteFolder: () => '/tmp/native-chat-pastes'
}))
vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))

import { Store } from '../persistence'
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

function invoke(channel: string, args?: unknown): unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`Missing clipboard handler: ${channel}`)
  }
  return handler(event, args)
}

function setImage(size = { width: 32, height: 24 }, empty = false) {
  const image = {
    isEmpty: () => empty,
    getSize: () => size,
    toPNG: mocks.toPNG,
    toDataURL: () => 'data:image/png;base64,PREVIEW'
  }
  mocks.readImage.mockReturnValue(image)
  return image
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  installFakeAppEnvironment({ getPath: () => '/tmp' })
  mocks.has.mockImplementation((type: string) => type === 'public.png')
  mocks.readBuffer.mockReturnValue(Buffer.alloc(0))
  mocks.createFromBuffer.mockReturnValue({ isEmpty: () => true })
  mocks.toPNG.mockReturnValue(PNG)
  mocks.writeFile.mockResolvedValue(undefined)
  setImage()
  setTrustedClipboardRendererWebContentsId(17)
  registerClipboardHandlers(new Store())
})

afterEach(() => {
  vi.restoreAllMocks()
  setTrustedClipboardRendererWebContentsId(null)
})

describe('macOS clipboard image data beside a file URL', () => {
  it.each(['public.png', 'public.tiff'])(
    'saves native %s image data as a local PNG',
    async (type) => {
      mocks.has.mockImplementation((format: string) => format === type)
      expect(invoke('clipboard:hasImage')).toBe(true)
      expect(mocks.readImage).not.toHaveBeenCalled()

      const savedPath = await invoke('clipboard:saveImageAsTempFile')
      expect(savedPath).toMatch(/orca-paste-.+\.png$/)
      expect(mocks.writeFile).toHaveBeenCalledWith(savedPath, PNG)
      expect(mocks.readBuffer).not.toHaveBeenCalled()
    }
  )

  it('does not decode or save a copied file without native image data', async () => {
    mocks.has.mockReturnValue(false)
    expect(invoke('clipboard:hasImage')).toBe(false)
    await expect(invoke('clipboard:saveImageAsTempFile')).resolves.toBeNull()
    expect(mocks.readImage).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('does not save malformed native image data or read its accompanying file', async () => {
    setImage({ width: 0, height: 0 }, true)
    mocks.readBuffer.mockReturnValue(Buffer.from('malformed image'))
    await expect(invoke('clipboard:saveImageAsTempFile')).resolves.toBeNull()
    expect(invoke('clipboard:readImageThumbnail')).toBeNull()
    expect(mocks.toPNG).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('saves and previews JPEG bytes stored under the native PNG type', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    setImage({ width: 0, height: 0 }, true)
    mocks.readBuffer.mockImplementation((type: string) =>
      type === 'public.png' ? jpeg : Buffer.alloc(0)
    )
    mocks.createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 32, height: 24 }),
      toPNG: mocks.toPNG,
      toDataURL: () => 'data:image/png;base64,PREVIEW'
    })

    expect(invoke('clipboard:hasImage')).toBe(true)
    const savedPath = await invoke('clipboard:saveImageAsTempFile')
    expect(savedPath).toMatch(/orca-paste-.+\.png$/)
    expect(mocks.writeFile).toHaveBeenCalledWith(savedPath, PNG)
    expect(invoke('clipboard:readImageThumbnail')).toEqual({
      dataUrl: 'data:image/png;base64,PREVIEW',
      width: 32,
      height: 24
    })
    expect(mocks.createFromBuffer).toHaveBeenCalledWith(jpeg)
  })

  it('rejects oversized raw image bytes before decoding and omits their preview', async () => {
    setImage({ width: 0, height: 0 }, true)
    mocks.readBuffer.mockReturnValue(Buffer.alloc(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1))

    await expect(invoke('clipboard:saveImageAsTempFile')).rejects.toThrow(
      'Clipboard image is too large'
    )
    expect(invoke('clipboard:readImageThumbnail')).toBeNull()
    expect(mocks.createFromBuffer).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('rejects oversized declared JPEG dimensions before decoding and omits their preview', async () => {
    const image = setImage()
    setImage({ width: 0, height: 0 }, true)
    // A small JPEG header can declare 6000 × 6000 pixels, above the clipboard limit.
    mocks.readBuffer.mockReturnValue(
      Buffer.from('ffd8ffc00011081770177003011100021100031100ffd9', 'hex')
    )
    mocks.createFromBuffer.mockReturnValue(image)

    await expect(invoke('clipboard:saveImageAsTempFile')).rejects.toThrow(
      'Clipboard image is too large'
    )
    expect(invoke('clipboard:readImageThumbnail')).toBeNull()
    expect(mocks.createFromBuffer).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('checks the renderer before attempting raw image recovery', async () => {
    setTrustedClipboardRendererWebContentsId(42)
    await expect(invoke('clipboard:saveImageAsTempFile')).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )
    expect(() => invoke('clipboard:readImageThumbnail')).toThrow(
      'Unauthorized clipboard IPC sender'
    )
    expect(mocks.readImage).not.toHaveBeenCalled()
    expect(mocks.readBuffer).not.toHaveBeenCalled()
  })

  it('checks the renderer before probing native image types', () => {
    setTrustedClipboardRendererWebContentsId(42)
    expect(() => invoke('clipboard:hasImage')).toThrow('Unauthorized clipboard IPC sender')
    expect(mocks.has).not.toHaveBeenCalled()
  })

  it.each([false, true])('rejects oversized dimensions with raw recovery: %s', async (recover) => {
    const image = setImage({ width: CLIPBOARD_IMAGE_MAX_PIXELS + 1, height: 1 })
    if (recover) {
      setImage({ width: 0, height: 0 }, true)
      mocks.readBuffer.mockReturnValue(Buffer.from([0xff, 0xd8]))
      mocks.createFromBuffer.mockReturnValue(image)
    }
    await expect(invoke('clipboard:saveImageAsTempFile')).rejects.toThrow(
      'Clipboard image is too large'
    )
    expect(mocks.toPNG).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it.each([false, true])('rejects oversized PNG output with raw recovery: %s', async (recover) => {
    if (recover) {
      const image = setImage()
      setImage({ width: 0, height: 0 }, true)
      mocks.readBuffer.mockReturnValue(Buffer.from([0xff, 0xd8]))
      mocks.createFromBuffer.mockReturnValue(image)
    }
    mocks.toPNG.mockReturnValue(Buffer.alloc(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1))
    await expect(
      invoke('clipboard:saveImageAsTempFile', { connectionId: 'ssh-1' })
    ).rejects.toThrow('Clipboard image is too large')
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
})
