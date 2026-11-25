import type { NativeImage, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

import { captureNativeChatFrame, nativeChatFrameCaptureRect } from './native-chat-frame-capture'

function contents(image: Partial<NativeImage>, zoom = 1) {
  const capturePage = vi.fn(async () => image)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these WebContents members.
  const fake = {
    getZoomFactor: () => zoom,
    capturePage,
    isDestroyed: () => false,
    getBackgroundThrottling: () => false,
    setBackgroundThrottling: vi.fn()
  } as unknown as WebContents
  return { fake, capturePage }
}

describe('nativeChatFrameCaptureRect', () => {
  it('accepts a measured rect and refuses anything else', () => {
    expect(nativeChatFrameCaptureRect({ x: 10, y: 20, width: 640, height: 360 })).toEqual({
      x: 10,
      y: 20,
      width: 640,
      height: 360
    })
    for (const bad of [
      null,
      'rect',
      { x: 0, y: 0, width: 0, height: 10 },
      { x: -1, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: Number.NaN, height: 10 },
      { x: 0, y: 0, width: 10 },
      { x: 0, y: 0, width: 100_000, height: 10 }
    ]) {
      expect(() => nativeChatFrameCaptureRect(bad)).toThrow('Invalid frame rect')
    }
  })
})

describe('captureNativeChatFrame', () => {
  it('captures the frame rect in window points and returns its PNG', async () => {
    const { fake, capturePage } = contents(
      {
        isEmpty: () => false,
        getSize: () => ({ width: 1000, height: 500 }),
        toPNG: () => Buffer.from([137, 80, 78, 71])
      },
      1.25
    )
    const png = await captureNativeChatFrame(fake, { x: 8, y: 16, width: 400, height: 200 })
    // CSS pixels scaled by the page zoom, kept hidden.
    expect(capturePage).toHaveBeenCalledWith(
      { x: 10, y: 20, width: 500, height: 250 },
      { stayHidden: true }
    )
    expect(Array.from(png)).toEqual([137, 80, 78, 71])
  })

  it('scales a capture larger than a marked image down to its long edge', async () => {
    const resized = { toPNG: () => Buffer.from([1]) }
    const resize = vi.fn(() => resized)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only these NativeImage members.
    const large = {
      isEmpty: () => false,
      getSize: () => ({ width: 5120, height: 2880 }),
      resize,
      toPNG: () => Buffer.from([2])
    } as unknown as Partial<NativeImage>
    const { fake } = contents(large)
    const png = await captureNativeChatFrame(fake, { x: 0, y: 0, width: 2560, height: 1440 })
    expect(resize).toHaveBeenCalledWith({ width: 2048, height: 1152, quality: 'best' })
    expect(Array.from(png)).toEqual([1])
  })

  it('fails rather than return an empty frame', async () => {
    const { fake } = contents({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      toPNG: () => Buffer.alloc(0)
    })
    await expect(
      captureNativeChatFrame(fake, { x: 0, y: 0, width: 10, height: 10 })
    ).rejects.toThrow('Nothing was drawn to capture')
  })
})
