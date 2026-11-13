import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startBrowserScreencast } from './browser-screencast-stream'
import type { BrowserScreencastOptions } from './browser-screencast-stream-types'
import { createMockScreencastWebContents } from './browser-screencast-web-contents-test-double'

function start(
  webContents: ReturnType<typeof createMockScreencastWebContents>,
  options: BrowserScreencastOptions
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream touches only the debugger, isDestroyed and capturePage the doubles provide.
  return startBrowserScreencast(webContents as never, options)
}

function startOptions(viewport: boolean) {
  return {
    format: 'jpeg' as const,
    quality: 70,
    maxWidth: 1440,
    maxHeight: 1200,
    everyNthFrame: 2,
    minFrameIntervalMs: 0,
    holdPaint: () => () => {},
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
