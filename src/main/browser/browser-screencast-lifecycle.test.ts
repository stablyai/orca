import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { createBrowserScreencastMessageHandler } from './browser-screencast-cdp-events'
import { startBrowserScreencast } from './browser-screencast-stream'

function createWebContents() {
  let attached = false
  const debuggerApi = new EventEmitter() as EventEmitter & {
    isAttached: ReturnType<typeof vi.fn>
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    sendCommand: ReturnType<typeof vi.fn>
  }
  debuggerApi.isAttached = vi.fn(() => attached)
  debuggerApi.attach = vi.fn(() => {
    attached = true
  })
  debuggerApi.detach = vi.fn(() => {
    attached = false
  })
  debuggerApi.sendCommand = vi.fn(async () => ({}))
  return { isDestroyed: vi.fn(() => false), debugger: debuggerApi }
}

describe('browser screencast lifecycle', () => {
  it('updates a live shared stream viewport and clears an obsolete override', async () => {
    const webContents = createWebContents()
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

    // Why: a joining subscriber always updates a stream that has already emitted
    // frames; without one this test cannot distinguish the initial-snapshot path.
    webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
      sessionId: 7,
      data: Buffer.from('live-frame').toString('base64'),
      metadata: {}
    })
    expect(onFrame).toHaveBeenCalledOnce()

    await session.updateViewport({
      viewportWidth: 800,
      viewportHeight: 600,
      deviceScaleFactor: 2,
      mobile: true
    })
    expect(webContents.debugger.sendCommand).toHaveBeenLastCalledWith(
      'Page.captureScreenshot',
      expect.anything()
    )
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      { width: 800, height: 600, deviceScaleFactor: 2, mobile: true }
    )

    await session.updateViewport({
      viewportWidth: undefined,
      viewportHeight: undefined,
      deviceScaleFactor: undefined,
      mobile: false
    })
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.clearDeviceMetricsOverride',
      {}
    )
    session.stop()
    await session.done
  })

  it('restarts the screencast and retimes the pacer when the shared frame budget changes', async () => {
    const webContents = createWebContents()
    const onFrame = vi.fn()
    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 3840,
      maxHeight: 2160,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame
    })

    await session.updateFrameBudget({
      quality: 60,
      maxWidth: 975,
      maxHeight: 844,
      everyNthFrame: 1,
      minFrameIntervalMs: 100
    })
    expect(webContents.debugger.sendCommand).toHaveBeenLastCalledWith('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 975,
      maxHeight: 844,
      everyNthFrame: 1
    })

    const emitFrame = (sessionId: number): void => {
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        sessionId,
        data: Buffer.from(`frame-${sessionId}`).toString('base64'),
        metadata: {}
      })
    }
    emitFrame(1)
    emitFrame(2)
    // Why: the new interval only takes effect if the pacer reads it live off the shared
    // options; a pinned creator interval would let both frames straight through.
    expect(onFrame).toHaveBeenCalledOnce()

    session.stop()
    await session.done
  })

  it('acks malformed frames when Chromium supplied a valid session id', () => {
    const webContents = createWebContents()
    const ackScreencastFrame = vi.fn()
    const handler = createBrowserScreencastMessageHandler({
      dbg: webContents.debugger as never,
      options: {
        format: 'jpeg',
        quality: 70,
        maxWidth: 1440,
        maxHeight: 1200,
        everyNthFrame: 2,
        minFrameIntervalMs: 0,
        onFrame: vi.fn()
      },
      isClosed: () => false,
      isStopping: () => false,
      queueFrame: vi.fn(),
      ackScreencastFrame,
      scheduleNavigationFrameCapture: vi.fn(),
      clearNavigationCaptureTimer: vi.fn(),
      bumpSnapshotGeneration: vi.fn()
    })

    handler({}, 'Page.screencastFrame', { sessionId: 42, data: '' })
    expect(ackScreencastFrame).toHaveBeenCalledOnce()
    expect(ackScreencastFrame).toHaveBeenCalledWith(42)
  })
})
