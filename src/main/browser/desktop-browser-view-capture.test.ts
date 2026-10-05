import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createOwnedViewFixture } from './desktop-owned-browser-view-test-fixture'

const { capture, lookup, image, decode } = vi.hoisted(() => {
  const capture = vi.fn(async () => ({ data: Buffer.from('png fixture').toString('base64') }))
  const image = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 1200, height: 800 })),
    toDataURL: vi.fn(() => 'data:image/png;base64,cGl4ZWxz')
  }
  return { capture, lookup: vi.fn(() => capture), image, decode: vi.fn(() => image) }
})

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: decode } }))
vi.mock('./desktop-owned-browser-capture-registry', () => ({
  getDesktopOwnedBrowserCapture: lookup
}))

import { captureDesktopBrowserViewViewport } from './desktop-browser-view-capture'

describe('desktop annotation viewport capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    image.isEmpty.mockReturnValue(false)
    image.getSize.mockReturnValue({ width: 1200, height: 800 })
  })

  it('uses the retained capture transaction and returns decoded PNG dimensions', async () => {
    const { record } = createOwnedViewFixture()
    expect(await captureDesktopBrowserViewViewport(record)).toEqual({
      dataUrl: 'data:image/png;base64,cGl4ZWxz',
      width: 1200,
      height: 800
    })
    expect(lookup).toHaveBeenCalledWith(record.webContents)
    expect(capture).toHaveBeenCalledWith(
      {
        kind: 'screenshot',
        params: { format: 'png', captureBeyondViewport: false }
      },
      expect.any(Function)
    )
    expect(decode).toHaveBeenCalledWith(Buffer.from('png fixture'))
  })

  it('does not hand an empty native image to markup', async () => {
    image.isEmpty.mockReturnValue(true)
    await expect(
      captureDesktopBrowserViewViewport(createOwnedViewFixture().record)
    ).rejects.toThrow('empty')
    expect(image.toDataURL).not.toHaveBeenCalled()
  })

  it('preserves capture failure without manufacturing a frame', async () => {
    capture.mockRejectedValueOnce(new Error('page navigated'))
    await expect(
      captureDesktopBrowserViewViewport(createOwnedViewFixture().record)
    ).rejects.toThrow('page navigated')
    expect(decode).not.toHaveBeenCalled()
  })
})

it('rejects a nonempty one-pixel placeholder for a full-size owned view', async () => {
  image.getSize.mockReturnValue({ width: 1, height: 1 })
  await expect(captureDesktopBrowserViewViewport(createOwnedViewFixture().record)).rejects.toThrow(
    'not ready'
  )
  expect(image.toDataURL).not.toHaveBeenCalled()
})
