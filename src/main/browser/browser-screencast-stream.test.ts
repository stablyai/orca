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

function jpegWithSize(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9
  ])
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

  it('adds image dimensions to fallback capture frames', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        return { data: jpegWithSize(1200, 800).toString('base64') }
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
    expect(frame?.metadata).toMatchObject({ deviceWidth: 1200, deviceHeight: 800 })

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

  it('does not emit a stale navigation fallback capture after newer live frames', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    const pendingCaptures: ((value: { data: string }) => void)[] = []
    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        return await new Promise<{ data: string }>((resolve) => pendingCaptures.push(resolve))
      }
      return {}
    })
    const onFrame = vi.fn()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 1,
      minFrameIntervalMs: 0,
      onFrame
    })

    try {
      await Promise.resolve()
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('first-live-frame').toString('base64'),
        sessionId: 42,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      expect(onFrame).toHaveBeenCalledTimes(1)

      pendingCaptures[0]?.({ data: Buffer.from('stale-initial').toString('base64') })
      await Promise.resolve()
      await Promise.resolve()
      expect(onFrame).toHaveBeenCalledTimes(1)

      webContents.debugger.emit('message', {}, 'Page.loadEventFired', {})
      await vi.advanceTimersByTimeAsync(250)
      await Promise.resolve()
      expect(pendingCaptures).toHaveLength(2)

      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('newer-live-frame').toString('base64'),
        sessionId: 43,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      pendingCaptures[1]?.({ data: Buffer.from('stale-navigation').toString('base64') })
      await Promise.resolve()
      await Promise.resolve()

      expect(onFrame).toHaveBeenCalledTimes(2)
      const secondFrame = decodeBrowserScreencastFrame(onFrame.mock.calls[1][0])
      expect(Buffer.from(secondFrame?.image ?? new Uint8Array()).toString()).toBe(
        'newer-live-frame'
      )
    } finally {
      session.stop()
      await session.done
      vi.useRealTimers()
    }
  })

  it('reapplies client viewport emulation before navigation fallback captures', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        return { data: jpegWithSize(958, 609).toString('base64') }
      }
      return {}
    })
    const onFrame = vi.fn()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 3840,
      maxHeight: 2160,
      viewportWidth: 958,
      viewportHeight: 609,
      deviceScaleFactor: 1,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    try {
      await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
      const beforeNavigation = webContents.debugger.sendCommand.mock.calls.filter(
        ([method]) => method === 'Emulation.setDeviceMetricsOverride'
      ).length

      webContents.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main' } })
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(2))

      const afterNavigation = webContents.debugger.sendCommand.mock.calls.filter(
        ([method]) => method === 'Emulation.setDeviceMetricsOverride'
      ).length
      expect(afterNavigation).toBeGreaterThan(beforeNavigation)
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
        'Emulation.setDeviceMetricsOverride',
        {
          width: 958,
          height: 609,
          deviceScaleFactor: 1,
          mobile: false
        }
      )
    } finally {
      session.stop()
      await session.done
      vi.useRealTimers()
    }
  })

  it('captures a fresh fallback frame after static page navigation', async () => {
    const webContents = createMockWebContents()
    let captureCount = 0
    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        captureCount += 1
        return { data: Buffer.from(`capture-${captureCount}`).toString('base64') }
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
    webContents.debugger.emit('message', {}, 'Page.loadEventFired', {})

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(2))
    const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[1][0])
    expect(Buffer.from(frame?.image ?? new Uint8Array()).toString()).toBe('capture-2')

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
      await vi.waitFor(() =>
        expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
          sessionId: 43
        })
      )
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

  it('flushes the latest throttled live frame when the page becomes static', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    const onFrame = vi.fn()
    let now = 1000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 1,
      minFrameIntervalMs: 100,
      onFrame
    })

    try {
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('before-menu').toString('base64'),
        sessionId: 42,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      now = 1040
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('menu-opening').toString('base64'),
        sessionId: 43,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      now = 1060
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('menu-open-final').toString('base64'),
        sessionId: 44,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })

      expect(onFrame).toHaveBeenCalledTimes(1)
      now = 1100
      await vi.advanceTimersByTimeAsync(60)

      expect(onFrame).toHaveBeenCalledTimes(2)
      const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[1][0])
      expect(Buffer.from(frame?.image ?? new Uint8Array()).toString()).toBe('menu-open-final')
    } finally {
      dateNow.mockRestore()
      session.stop()
      await session.done
      vi.useRealTimers()
    }
  })

  it('does not ack a live frame until the binary sender accepts it', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    let sendAttempts = 0
    const onFrame = vi.fn(() => {
      sendAttempts += 1
      return sendAttempts > 1
    })

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 1,
      minFrameIntervalMs: 0,
      onFrame
    })

    try {
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('backpressured-frame').toString('base64'),
        sessionId: 42,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })

      expect(onFrame).toHaveBeenCalledTimes(1)
      expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Page.screencastFrameAck', {
        sessionId: 42
      })

      await vi.advanceTimersByTimeAsync(50)

      expect(onFrame).toHaveBeenCalledTimes(2)
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
        sessionId: 42
      })
    } finally {
      session.stop()
      await session.done
      vi.useRealTimers()
    }
  })

  it('drops pending and late screencast frames after stop is requested', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    const onFrame = vi.fn()
    let now = 1000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 1,
      minFrameIntervalMs: 100,
      onFrame
    })

    let stopped = false
    try {
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('before-stop').toString('base64'),
        sessionId: 42,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      now = 1040
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('pending-before-stop').toString('base64'),
        sessionId: 43,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      expect(onFrame).toHaveBeenCalledTimes(1)

      session.stop()
      stopped = true
      now = 1060
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('late-after-stop').toString('base64'),
        sessionId: 44,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      await vi.advanceTimersByTimeAsync(200)
      await session.done

      expect(onFrame).toHaveBeenCalledTimes(1)
      const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[0][0])
      expect(Buffer.from(frame?.image ?? new Uint8Array()).toString()).toBe('before-stop')
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
        sessionId: 44
      })
    } finally {
      dateNow.mockRestore()
      if (!stopped) {
        session.stop()
        await session.done
      }
      vi.useRealTimers()
    }
  })

  it('enriches viewport-sized live frames with requested viewport dimensions', async () => {
    const webContents = createMockWebContents()
    const onFrame = vi.fn()
    const image = jpegWithSize(390, 720)

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      viewportWidth: 390,
      viewportHeight: 720,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
      data: image.toString('base64'),
      sessionId: 42,
      metadata: {}
    })

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[0][0])
    expect(frame?.metadata).toMatchObject({
      deviceWidth: 390,
      deviceHeight: 720,
      imageWidth: 390,
      imageHeight: 720
    })

    session.stop()
    await session.done
  })

  it('keeps requested viewport dimensions for DPR-sized live frames without CDP metadata', async () => {
    const webContents = createMockWebContents()
    const onFrame = vi.fn()
    const image = jpegWithSize(780, 1440)

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      viewportWidth: 390,
      viewportHeight: 720,
      deviceScaleFactor: 2,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
      data: image.toString('base64'),
      sessionId: 42,
      metadata: {}
    })

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[0][0])
    expect(frame?.metadata).toMatchObject({
      deviceWidth: 390,
      deviceHeight: 720,
      imageWidth: 780,
      imageHeight: 1440
    })

    session.stop()
    await session.done
  })

  it('keeps requested viewport dimensions for CSS-sized high-DPI live frames', async () => {
    const webContents = createMockWebContents()
    const onFrame = vi.fn()
    const image = jpegWithSize(390, 720)

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      viewportWidth: 390,
      viewportHeight: 720,
      deviceScaleFactor: 2,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
      data: image.toString('base64'),
      sessionId: 42,
      metadata: {}
    })

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[0][0])
    expect(frame?.metadata).toMatchObject({
      deviceWidth: 390,
      deviceHeight: 720,
      imageWidth: 390,
      imageHeight: 720
    })

    session.stop()
    await session.done
  })

  it('keeps requested viewport dimensions for max-size-scaled high-DPI live frames', async () => {
    const webContents = createMockWebContents()
    const onFrame = vi.fn()
    const image = jpegWithSize(3240, 2160)

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 3840,
      maxHeight: 2160,
      viewportWidth: 3000,
      viewportHeight: 2000,
      deviceScaleFactor: 2,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
      data: image.toString('base64'),
      sessionId: 42,
      metadata: {}
    })

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[0][0])
    expect(frame?.metadata).toMatchObject({
      deviceWidth: 3000,
      deviceHeight: 2000,
      imageWidth: 3240,
      imageHeight: 2160
    })

    session.stop()
    await session.done
  })

  it('drops host-sized live frames when a client viewport was requested', async () => {
    const webContents = createMockWebContents()
    const onFrame = vi.fn()
    const image = jpegWithSize(2266, 1309)

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 3840,
      maxHeight: 2160,
      viewportWidth: 958,
      viewportHeight: 609,
      deviceScaleFactor: 1,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
      data: image.toString('base64'),
      sessionId: 42,
      metadata: {}
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onFrame).not.toHaveBeenCalled()
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
      sessionId: 42
    })

    session.stop()
    await session.done
  })

  it('keeps requested viewport dimensions over CDP-reported live dimensions', async () => {
    const webContents = createMockWebContents()
    const onFrame = vi.fn()
    const image = jpegWithSize(390, 720)

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      viewportWidth: 390,
      viewportHeight: 720,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
      data: image.toString('base64'),
      sessionId: 42,
      metadata: { deviceWidth: 900, deviceHeight: 500, imageWidth: 900, imageHeight: 500 }
    })

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[0][0])
    expect(frame?.metadata).toMatchObject({
      deviceWidth: 390,
      deviceHeight: 720,
      imageWidth: 390,
      imageHeight: 720
    })

    session.stop()
    await session.done
  })

  it('forwards browser JavaScript dialog events to the stream client', async () => {
    const webContents = createMockWebContents()
    const onEvent = vi.fn()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame: vi.fn(),
      onEvent
    })

    webContents.debugger.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Continue?'
    })
    webContents.debugger.emit('message', {}, 'Page.javascriptDialogClosed', {})

    expect(onEvent).toHaveBeenNthCalledWith(1, {
      type: 'dialog',
      dialogType: 'confirm',
      message: 'Continue?'
    })
    expect(onEvent).toHaveBeenNthCalledWith(2, { type: 'dialogClosed' })

    session.stop()
    await session.done
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

  it('does not clear an existing viewport override for size-neutral streams', async () => {
    const webContents = createMockWebContents()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame: vi.fn()
    })

    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Emulation.clearDeviceMetricsOverride'
    )

    session.stop()
    await session.done
  })

  it('applies mobile device metrics when requested', async () => {
    const webContents = createMockWebContents()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 3840,
      maxHeight: 2160,
      viewportWidth: 390,
      viewportHeight: 720,
      mobile: true,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame: vi.fn()
    })

    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      {
        width: 390,
        height: 720,
        deviceScaleFactor: 1,
        mobile: true
      }
    )

    session.stop()
    await session.done
  })
})
