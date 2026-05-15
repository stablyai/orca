import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { decodeBrowserScreencastFrame } from '../../shared/browser-screencast-protocol'
import { startBrowserScreencast } from './browser-screencast-stream'

function createMockWebContents() {
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

  return {
    isDestroyed: vi.fn(() => false),
    debugger: dbg
  }
}

describe('startBrowserScreencast', () => {
  it('emits an initial captured frame before CDP produces screencast events', async () => {
    const webContents = createMockWebContents()
    const firstFrame = Buffer.from('first-frame')
    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        return { data: firstFrame.toString('base64') }
      }
      return {}
    })
    const onFrame = vi.fn()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[0][0])
    expect(frame?.seq).toBe(0)
    expect(frame?.format).toBe('jpeg')
    expect(Buffer.from(frame?.image ?? new Uint8Array()).toString()).toBe('first-frame')
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 70,
      captureBeyondViewport: false
    })

    session.stop()
    await session.done
  })

  it('does not emit a stale initial capture after a live screencast frame arrives', async () => {
    const webContents = createMockWebContents()
    let resolveInitialCapture!: (value: { data: string }) => void
    const initialCapture = new Promise<{ data: string }>((resolve) => {
      resolveInitialCapture = resolve
    })
    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        return await initialCapture
      }
      return {}
    })
    const onFrame = vi.fn()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
      data: Buffer.from('live-frame').toString('base64'),
      sessionId: 42,
      metadata: { deviceWidth: 800, deviceHeight: 600 }
    })
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))

    resolveInitialCapture({ data: Buffer.from('stale-frame').toString('base64') })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[0][0])
    expect(Buffer.from(frame?.image ?? new Uint8Array()).toString()).toBe('live-frame')
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
      sessionId: 42
    })

    session.stop()
    await session.done
  })

  it('throttles live frames before sending them to the client stream', async () => {
    const webContents = createMockWebContents()
    const onFrame = vi.fn()
    let now = 1000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 2,
      minFrameIntervalMs: 100,
      onFrame
    })

    try {
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('first-live-frame').toString('base64'),
        sessionId: 42,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      now = 1050
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('dropped-live-frame').toString('base64'),
        sessionId: 43,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      now = 1120
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('second-live-frame').toString('base64'),
        sessionId: 44,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })

      expect(onFrame).toHaveBeenCalledTimes(2)
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
        sessionId: 43
      })
      const secondFrame = decodeBrowserScreencastFrame(onFrame.mock.calls[1][0])
      expect(Buffer.from(secondFrame?.image ?? new Uint8Array()).toString()).toBe(
        'second-live-frame'
      )
    } finally {
      dateNow.mockRestore()
      session.stop()
      await session.done
    }
  })

  it('applies the client viewport before the screencast starts', async () => {
    const webContents = createMockWebContents()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 3840,
      maxHeight: 2160,
      viewportWidth: 1010,
      viewportHeight: 640,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame: vi.fn()
    })

    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      {
        width: 1010,
        height: 640,
        deviceScaleFactor: 1,
        mobile: false
      }
    )
    const methods = webContents.debugger.sendCommand.mock.calls.map((call) => call[0])
    expect(methods.indexOf('Emulation.setDeviceMetricsOverride')).toBeLessThan(
      methods.indexOf('Page.startScreencast')
    )

    session.stop()
    await session.done
  })
})
