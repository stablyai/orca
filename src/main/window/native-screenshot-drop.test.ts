import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../shared/clipboard-image'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  createFromBuffer: vi.fn(),
  save: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler },
  nativeImage: { createFromBuffer: mocks.createFromBuffer }
}))
vi.mock('./clipboard-image-temp-file', () => ({ saveClipboardImageBufferAsTempFile: mocks.save }))

import { registerNativeScreenshotDropHandler } from './native-screenshot-drop'

describe('dropped screenshot persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mocks.createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 10, height: 10 }),
      toPNG: () => Buffer.from('encoded PNG')
    })
    mocks.save.mockResolvedValue('/tmp/orca-paste-owned.png')
  })
  afterEach(() => vi.restoreAllMocks())

  function handler(authorize = vi.fn()): (event: unknown, bytes: unknown) => Promise<string> {
    registerNativeScreenshotDropHandler(authorize)
    return mocks.handle.mock.calls[0][1]
  }

  it('normalizes bytes to PNG using the existing authorized temp-file writer', async () => {
    const authorize = vi.fn()
    const event = { sender: 'owning-renderer' }
    expect(await handler(authorize)(event, new Uint8Array([1, 2, 3]))).toBe(
      '/tmp/orca-paste-owned.png'
    )
    expect(authorize).toHaveBeenCalledWith(event)
    expect(mocks.save).toHaveBeenCalledWith(Buffer.from('encoded PNG'))
  })

  it('denies an untrusted sender before decoding or writing', async () => {
    const authorize = vi.fn(() => {
      throw new Error('Unauthorized')
    })
    await expect(handler(authorize)({}, new Uint8Array([1]))).rejects.toThrow('Unauthorized')
    expect(mocks.createFromBuffer).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it.each([null, '/private/file.png', { byteLength: 1 }])(
    'rejects malformed input %s',
    async (bytes) => {
      await expect(handler()({}, bytes)).rejects.toThrow('Invalid dropped screenshot')
      expect(mocks.save).not.toHaveBeenCalled()
    }
  )

  it('rejects oversized input before decoding', async () => {
    await expect(
      handler()({}, new Uint8Array(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1))
    ).rejects.toThrow('too large')
    expect(mocks.createFromBuffer).not.toHaveBeenCalled()
  })

  it('rejects invalid image data and oversized dimensions', async () => {
    const invoke = handler()
    mocks.createFromBuffer.mockReturnValue({ isEmpty: () => true })
    await expect(invoke({}, new Uint8Array([1]))).rejects.toThrow('Invalid dropped screenshot')
    mocks.createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1e9, height: 1e9 })
    })
    await expect(invoke({}, new Uint8Array([1]))).rejects.toThrow('too large')
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('rejects calls on other operating systems', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await expect(handler()({}, new Uint8Array([1]))).rejects.toThrow('Invalid dropped screenshot')
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
