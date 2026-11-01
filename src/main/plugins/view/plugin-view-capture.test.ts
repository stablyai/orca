import type { NativeImage, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  capturePluginPanelPng,
  compositeBitmap,
  looksBlank,
  pluginPanelCaptureRect,
  PLUGIN_SHOT_MAX_PNG_BYTES,
  settlePluginFrameGuest,
  withPaintingWhileHidden
} from './plugin-view-capture'

function image(size: { width: number; height: number }, png = Buffer.from('png')): NativeImage {
  const resized = vi.fn((target: { width: number; height: number }) => image(target, png))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these NativeImage members.
  return {
    isEmpty: () => size.width === 0,
    getSize: () => size,
    resize: resized,
    // A drawn panel: more than a background and a border.
    toBitmap: () => Buffer.from([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]),
    toPNG: () => png
  } as unknown as NativeImage
}

function contents(overrides: Record<string, unknown> = {}): WebContents {
  let throttled = true
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these WebContents members.
  return {
    isDestroyed: () => false,
    getBackgroundThrottling: () => throttled,
    setBackgroundThrottling: vi.fn((allowed: boolean) => {
      throttled = allowed
    }),
    getZoomFactor: () => 1,
    capturePage: vi.fn(async () => image({ width: 720, height: 1400 })),
    ...overrides
  } as unknown as WebContents
}

describe('pluginPanelCaptureRect', () => {
  it('scales CSS pixels by the zoom and rounds to whole points', () => {
    expect(pluginPanelCaptureRect({ x: 10.4, y: 20.6, width: 300, height: 500.5 }, 1.25)).toEqual({
      x: 13,
      y: 26,
      width: 375,
      height: 626
    })
    expect(pluginPanelCaptureRect({ x: -2, y: 0, width: 1, height: 1 }, Number.NaN)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1
    })
  })
})

describe('capturePluginPanelPng', () => {
  it('captures the rect and scales a HiDPI image to one pixel per point', async () => {
    const target = contents()
    const shot = await capturePluginPanelPng(target, { x: 900, y: 40, width: 360, height: 700 })
    expect(target.capturePage).toHaveBeenCalledWith(
      { x: 900, y: 40, width: 360, height: 700 },
      { stayHidden: true }
    )
    expect(shot).toMatchObject({ width: 360, height: 700 })
    expect(shot.png.toString()).toBe('png')
  })

  it('fails on an empty capture, a zero rect and an oversized PNG', async () => {
    await expect(
      capturePluginPanelPng(contents({ capturePage: async () => image({ width: 0, height: 0 }) }), {
        x: 0,
        y: 0,
        width: 10,
        height: 10
      })
    ).rejects.toThrow(/drew nothing/)
    await expect(
      capturePluginPanelPng(contents(), { x: 0, y: 0, width: 0, height: 10 })
    ).rejects.toThrow(/no area/)
    const huge = Buffer.alloc(PLUGIN_SHOT_MAX_PNG_BYTES + 1)
    await expect(
      capturePluginPanelPng(
        contents({ capturePage: async () => image({ width: 10, height: 10 }, huge) }),
        { x: 0, y: 0, width: 10, height: 10 }
      )
    ).rejects.toThrow(/smaller --width/)
  })
})

describe('withPaintingWhileHidden', () => {
  it('unthrottles for the capture and restores only what it changed', async () => {
    const throttled = contents()
    const already = contents({ getBackgroundThrottling: () => false })
    await expect(
      withPaintingWhileHidden([throttled, already], async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(throttled.setBackgroundThrottling).toHaveBeenNthCalledWith(1, false)
    expect(throttled.setBackgroundThrottling).toHaveBeenNthCalledWith(2, true)
    expect(already.setBackgroundThrottling).not.toHaveBeenCalled()
  })
})

describe('settlePluginFrameGuest', () => {
  it('waits for the guest frames and tolerates a missing or failing guest', async () => {
    await expect(settlePluginFrameGuest(undefined)).resolves.toBeUndefined()
    const executeJavaScript = vi.fn().mockRejectedValue(new Error('navigated'))
    await expect(settlePluginFrameGuest(contents({ executeJavaScript }))).resolves.toBeUndefined()
    expect(executeJavaScript).toHaveBeenCalledTimes(1)
  })
})

describe('compositeBitmap', () => {
  const solid = (width: number, height: number, value: number) => ({
    bitmap: Buffer.alloc(width * height * 4, value),
    width,
    height
  })

  it('draws the guest over the window capture at its offset, clipped to the panel', () => {
    const out = compositeBitmap(solid(4, 3, 0), solid(3, 2, 9), 2, 1)
    const at = (x: number, y: number) => out[(y * 4 + x) * 4]
    expect([at(0, 0), at(1, 1), at(2, 1), at(3, 1), at(3, 2), at(2, 0)]).toEqual([0, 0, 9, 9, 9, 0])
    expect(out.byteLength).toBe(4 * 3 * 4)
  })
})

describe('capturePluginPanelPng with an html guest', () => {
  function bitmapImage(size: { width: number; height: number }, value: number): NativeImage {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these NativeImage members.
    return {
      isEmpty: () => size.width === 0,
      getSize: () => size,
      resize: (target: { width: number; height: number }) => bitmapImage(target, value),
      toBitmap: () => Buffer.alloc(size.width * size.height * 4, value),
      toPNG: () => Buffer.from(`png-${value}`)
    } as unknown as NativeImage
  }

  it("captures the guest's own contents and composites it, since Linux leaves it blank", async () => {
    const host = contents({
      capturePage: vi.fn(async () => bitmapImage({ width: 20, height: 10 }, 0))
    })
    const guest = contents({
      capturePage: vi.fn(async () => bitmapImage({ width: 32, height: 16 }, 200))
    })
    const fromBitmap = vi.fn((bitmap: Buffer, size: { width: number; height: number }) => {
      expect(size).toEqual({ width: 20, height: 10 })
      // Guest rect (2, 2, 16x8) inside the panel at (0, 0): its pixels replace the host's there.
      expect(bitmap[(0 * 20 + 0) * 4]).toBe(0)
      expect(bitmap[(3 * 20 + 3) * 4]).toBe(200)
      return bitmapImage(size, 7)
    })
    const shot = await capturePluginPanelPng(
      host,
      { x: 0, y: 0, width: 20, height: 10 },
      { contents: guest, rect: { x: 2, y: 2, width: 16, height: 8 }, fromBitmap }
    )
    expect(guest.capturePage).toHaveBeenCalledWith()
    expect(fromBitmap).toHaveBeenCalledOnce()
    expect(shot).toEqual({ png: Buffer.from('png-7'), width: 20, height: 10 })
  })
})

describe('capturePluginPanelPng retries a bare-background capture', () => {
  function solidImage(size: { width: number; height: number }, colors: number[]): NativeImage {
    const bitmap = Buffer.alloc(size.width * size.height * 4)
    for (let pixel = 0; pixel < size.width * size.height; pixel += 1) {
      bitmap.writeUInt32LE(colors[pixel % colors.length], pixel * 4)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these NativeImage members.
    return {
      isEmpty: () => false,
      getSize: () => size,
      resize: () => solidImage(size, colors),
      toBitmap: () => bitmap,
      toPNG: () => Buffer.from(`png-${colors.length}`)
    } as unknown as NativeImage
  }

  it('recaptures until the panel has drawn, then stops', async () => {
    const size = { width: 4, height: 4 }
    const shots = [solidImage(size, [1]), solidImage(size, [1, 2]), solidImage(size, [1, 2, 3])]
    const host = contents({
      capturePage: vi.fn(async () => shots.shift() ?? solidImage(size, [9]))
    })
    const wait = vi.fn(async () => undefined)
    const shot = await capturePluginPanelPng(host, { x: 0, y: 0, ...size }, undefined, wait)
    expect(host.capturePage).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(shot.png).toEqual(Buffer.from('png-3'))
  })

  it('gives up after its retries and returns the last capture of a truly plain panel', async () => {
    const size = { width: 2, height: 2 }
    const host = contents({ capturePage: vi.fn(async () => solidImage(size, [5])) })
    const shot = await capturePluginPanelPng(
      host,
      { x: 0, y: 0, ...size },
      undefined,
      async () => {}
    )
    expect(host.capturePage).toHaveBeenCalledTimes(9)
    expect(shot.png).toEqual(Buffer.from('png-1'))
  })
})

describe('looksBlank', () => {
  it('is true for one or two colors and false from three', () => {
    const pixels = (...values: number[]) => {
      const bitmap = Buffer.alloc(values.length * 4)
      values.forEach((value, index) => bitmap.writeUInt32LE(value, index * 4))
      return bitmap
    }
    expect(looksBlank(pixels(7, 7, 7))).toBe(true)
    expect(looksBlank(pixels(7, 8, 7))).toBe(true)
    expect(looksBlank(pixels(7, 8, 9))).toBe(false)
  })
})
