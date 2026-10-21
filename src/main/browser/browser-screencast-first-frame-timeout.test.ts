/**
 * A hidden, throttled embedder stops compositing: capturePage never settles and no live frame
 * comes. The stream says so once, 10 s after it started, and only if no frame arrived by then.
 */
import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startBrowserScreencast } from './browser-screencast-stream'
import type { BrowserScreencastOptions } from './browser-screencast-stream-types'
import { createMockScreencastWebContents } from './browser-screencast-web-contents-test-double'

function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

function start(
  webContents: ReturnType<typeof createMockScreencastWebContents>,
  options: BrowserScreencastOptions
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream touches only the debugger, isDestroyed and capturePage the doubles provide.
  return startBrowserScreencast(webContents as never, options)
}

function liveFrame(webContents: ReturnType<typeof createMockScreencastWebContents>): void {
  webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
    data: Buffer.from('live').toString('base64'),
    sessionId: 1,
    metadata: { deviceWidth: 390, deviceHeight: 844, pageScaleFactor: 1 }
  })
}

function startOptions(viewport: boolean) {
  return {
    format: 'jpeg' as const,
    quality: 70,
    maxWidth: 1440,
    maxHeight: 1200,
    everyNthFrame: 2,
    minFrameIntervalMs: 0,
    ...(viewport ? { viewportWidth: 390, viewportHeight: 844 } : {}),
    onFrame: vi.fn(() => true),
    onError: vi.fn()
  }
}

describe('browser screencast first-frame deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports no frame at exactly 10 s when the captures hang', async () => {
    const webContents = Object.assign(createMockScreencastWebContents(), {
      capturePage: vi.fn(() => never())
    })
    webContents.debugger.sendCommand.mockImplementation(async (method: string) =>
      method === 'Page.captureScreenshot' ? never() : {}
    )
    const options = startOptions(true)
    const session = await start(webContents, options)

    await vi.advanceTimersByTimeAsync(9_999)
    expect(options.onError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(options.onError).toHaveBeenCalledExactlyOnceWith('Browser stream timed out.')
    session.stop()
    // The stop queues behind the capture: capturePage's 10 s bound, then the fallback's 8 s.
    await vi.advanceTimersByTimeAsync(8_000)
    await session.done
  })

  it.each(['live', 'snapshot'] as const)('stays quiet once a %s frame arrives', async (kind) => {
    const webContents = Object.assign(createMockScreencastWebContents(), {
      capturePage: vi.fn(() => never())
    })
    webContents.debugger.sendCommand.mockImplementation(async (method: string) =>
      method === 'Page.captureScreenshot' ? { data: Buffer.from('frame').toString('base64') } : {}
    )
    const options = startOptions(kind === 'live')
    const session = await start(webContents, options)
    if (kind === 'live') {
      liveFrame(webContents)
    }

    await vi.advanceTimersByTimeAsync(30_000)

    expect(options.onFrame).toHaveBeenCalled()
    expect(options.onError).not.toHaveBeenCalled()
    session.stop()
    await session.done
  })

  it('drops a capture that settles after the limit', async () => {
    let settleCapture!: (image: unknown) => void
    const webContents = Object.assign(createMockScreencastWebContents(), {
      capturePage: vi.fn(
        () =>
          new Promise((resolve) => {
            settleCapture = resolve
          })
      )
    })
    const options = startOptions(true)
    const session = await start(webContents, options)
    await vi.advanceTimersByTimeAsync(10_000)

    settleCapture({
      getSize: () => ({ width: 390, height: 844 }),
      toJPEG: () => Buffer.from('late'),
      toPNG: () => Buffer.from('late')
    })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(options.onFrame).not.toHaveBeenCalled()
    session.stop()
    await session.done
  })
})
