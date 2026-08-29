import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { startBrowserScreencast } from './browser-screencast-stream'

function createMockWebContents(capturePage: () => Promise<unknown>) {
  let attached = false
  const dbg = new EventEmitter() as EventEmitter & {
    isAttached: ReturnType<typeof vi.fn>
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    sendCommand: ReturnType<typeof vi.fn>
  }
  dbg.isAttached = vi.fn(() => attached)
  dbg.attach = vi.fn(() => {
    attached = true
  })
  dbg.detach = vi.fn(() => {
    attached = false
  })
  dbg.sendCommand = vi.fn(async () => ({}))
  return { isDestroyed: vi.fn(() => false), debugger: dbg, capturePage: vi.fn(capturePage) }
}

function createCapturedImage(width: number, height: number) {
  const resized = {
    getSize: vi.fn(() => ({ width, height })),
    resize: vi.fn(),
    toJPEG: vi.fn(() => Buffer.from('scaled-frame')),
    toPNG: vi.fn(() => Buffer.from('scaled-frame'))
  }
  const image = {
    getSize: vi.fn(() => ({ width, height })),
    resize: vi.fn(() => resized),
    toJPEG: vi.fn(() => Buffer.from('captured-frame')),
    toPNG: vi.fn(() => Buffer.from('captured-frame'))
  }
  return { image, resized }
}

describe('browser screencast snapshot scaling', () => {
  it('scales a hi-DPI capture down to the requested frame bounds', async () => {
    const { image, resized } = createCapturedImage(4000, 3000)
    const webContents = createMockWebContents(async () => image)
    const onFrame = vi.fn()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      viewportWidth: 2000,
      viewportHeight: 1500,
      deviceScaleFactor: 2,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    expect(image.resize).toHaveBeenCalledWith({ width: 1440, height: 1080 })
    expect(resized.toJPEG).toHaveBeenCalledWith(70)
    expect(image.toJPEG).not.toHaveBeenCalled()

    session.stop()
    await session.done
  })

  it('leaves a capture already within the frame bounds unscaled', async () => {
    const { image } = createCapturedImage(1200, 800)
    const webContents = createMockWebContents(async () => image)
    const onFrame = vi.fn()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      viewportWidth: 1200,
      viewportHeight: 800,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    expect(image.resize).not.toHaveBeenCalled()
    expect(image.toJPEG).toHaveBeenCalledWith(70)

    session.stop()
    await session.done
  })
})
