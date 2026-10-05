import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureFullPageScreenshot, captureScreenshot } from './cdp-screenshot'
import { browserCaptureIdle } from './browser-capture-idle'

function createMockWebContents() {
  const mock = {
    isDestroyed: vi.fn(() => false),
    invalidate: vi.fn(),
    capturePage: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => true),
      sendCommand: vi.fn()
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the capture calls.
  return Object.assign(mock, { guest: mock as unknown as WebContents })
}

const noHold = (): (() => void) => () => {}
const TIMEOUT_MESSAGE = 'Screenshot timed out — the browser page did not draw a frame.'

function pendingValue<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('capture surface reservation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits across layout, primary capture and a late native pulse before allowing a move', async () => {
    vi.useFakeTimers()
    const contents = createMockWebContents()
    const layout = pendingValue<{ cssContentSize: { width: number; height: number } }>()
    const primary = pendingValue<{ data: string }>()
    const native = pendingValue<{ isEmpty: () => boolean }>()
    contents.debugger.sendCommand.mockImplementation((method: string) =>
      method === 'Page.getLayoutMetrics' ? layout.promise : primary.promise
    )
    contents.capturePage.mockReturnValue(native.promise)
    const capture = captureFullPageScreenshot(contents.guest, 'png', noHold)
    let movable = false
    const move = browserCaptureIdle.reserve(contents.guest).then((lease) => {
      movable = true
      return lease
    })
    await Promise.resolve()
    expect(movable).toBe(false)
    layout.resolve({ cssContentSize: { width: 1152, height: 2728 } })
    await vi.advanceTimersByTimeAsync(250)
    expect(contents.capturePage).toHaveBeenCalledOnce()
    expect(movable).toBe(false)
    primary.resolve({ data: 'full-page' })
    await expect(capture).resolves.toEqual({ data: 'full-page', format: 'png' })
    expect(movable).toBe(false)
    native.resolve({ isEmpty: () => true })
    const lease = await move
    expect(movable).toBe(true)
    lease.release()
  })

  it('retains an unanswered layout request after the caller times out', async () => {
    vi.useFakeTimers()
    const contents = createMockWebContents()
    const layout = pendingValue<{ cssContentSize: { width: number; height: number } }>()
    contents.debugger.sendCommand.mockReturnValue(layout.promise)
    const capture = captureFullPageScreenshot(contents.guest, 'png', noHold)
    const failed = expect(capture).rejects.toThrow('page did not respond')
    await vi.advanceTimersByTimeAsync(8000)
    await failed
    expect(browserCaptureIdle.isIdle(contents.guest)).toBe(false)
    const move = browserCaptureIdle.reserve(contents.guest)
    layout.resolve({ cssContentSize: { width: 1152, height: 2728 } })
    const lease = await move
    expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(1)
    expect(contents.capturePage).not.toHaveBeenCalled()
    lease.release()
  })
})

describe('captureScreenshot', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('invalidates the guest before forwarding Page.captureScreenshot', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockResolvedValueOnce({ data: 'png-data' })

    await expect(captureScreenshot(webContents.guest, { format: 'png' }, noHold)).resolves.toEqual({
      data: 'png-data'
    })

    expect(webContents.invalidate).toHaveBeenCalledTimes(1)
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png'
    })
  })

  it('holds paint for the capture and releases it when the capture fails', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    const holdPaint = vi.fn(() => {
      events.push('hold')
      return () => events.push('release')
    })
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => {
      events.push('capture')
      return new Promise(() => {})
    })
    webContents.capturePage.mockImplementation(() => new Promise(() => {}))

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, holdPaint)
    const settled = expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(9000)
    await settled

    expect(events[0]).toBe('hold')
    expect(events.at(-1)).toBe('release')
    expect(events.filter((event) => event === 'release')).toHaveLength(1)
  })

  it('keeps capture idle busy after the caller deadline until the primary and native promises settle', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    let resolvePrimary: ((value: { data: string }) => void) | undefined
    let resolveNative: ((value: { isEmpty: () => boolean }) => void) | undefined
    webContents.debugger.sendCommand.mockImplementation(
      () =>
        new Promise<{ data: string }>((resolve) => {
          resolvePrimary = resolve
        })
    )
    webContents.capturePage.mockImplementation(
      () =>
        new Promise<{ isEmpty: () => boolean }>((resolve) => {
          resolveNative = resolve
        })
    )

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const failed = expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(8000)
    await failed
    expect(browserCaptureIdle.isIdle(webContents.guest)).toBe(false)

    const settled = browserCaptureIdle.waitForIdle(webContents.guest)
    resolveNative?.({ isEmpty: () => true })
    resolvePrimary?.({ data: 'late-primary' })
    await settled
    expect(browserCaptureIdle.isIdle(webContents.guest)).toBe(true)
  })

  it('uses one hidden native frame pulse instead of repeating the CDP capture', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    let resolveCapture: ((value: { data: string }) => void) | undefined
    webContents.debugger.sendCommand.mockImplementationOnce(
      () =>
        new Promise<{ data: string }>((resolve) => {
          resolveCapture = resolve
        })
    )
    webContents.capturePage.mockImplementation(() => {
      resolveCapture?.({ data: 'drawn-png' })
      return Promise.resolve({ isEmpty: () => false })
    })

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(250)

    await expect(capture).resolves.toEqual({ data: 'drawn-png' })
    expect(webContents.debugger.sendCommand.mock.calls).toEqual([
      ['Page.captureScreenshot', { format: 'png' }]
    ])
    expect(webContents.capturePage).toHaveBeenCalledWith(undefined, {
      stayHidden: true,
      stayAwake: false
    })
  })

  it('does not start another native frame pulse while the prior one remains unresolved', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    let resolveCapture: ((value: { data: string }) => void) | undefined
    let resolveNative: (() => void) | undefined
    webContents.debugger.sendCommand.mockImplementationOnce(
      () =>
        new Promise<{ data: string }>((resolve) => {
          resolveCapture = resolve
        })
    )
    webContents.capturePage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveNative = () => resolve({ isEmpty: () => false })
        })
    )

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(4000)

    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
    resolveNative?.()
    resolveCapture?.({ data: 'slow-png' })
    await expect(capture).resolves.toEqual({ data: 'slow-png' })
  })

  it('absorbs synchronous and asynchronous native pulse failures without replacing the CDP result', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    let resolveCapture: ((value: { data: string }) => void) | undefined
    webContents.debugger.sendCommand.mockImplementationOnce(
      () =>
        new Promise<{ data: string }>((resolve) => {
          resolveCapture = resolve
        })
    )
    webContents.capturePage
      .mockImplementationOnce(() => {
        throw new Error('synchronous native pulse failure')
      })
      .mockRejectedValueOnce(new Error('asynchronous native pulse failure'))
      .mockImplementationOnce(() => {
        resolveCapture?.({ data: 'primary-cdp-result' })
        return Promise.resolve({ isEmpty: () => true })
      })

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(1750)

    await expect(capture).resolves.toEqual({ data: 'primary-cdp-result' })
    expect(webContents.debugger.sendCommand).toHaveBeenCalledTimes(1)
    expect(webContents.capturePage).toHaveBeenCalledTimes(3)
  })

  it('keeps clipped JPEG parameters on the sole CDP capture while native output is discarded', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    const params = {
      format: 'jpeg',
      quality: 73,
      clip: { x: 8, y: 16, width: 320, height: 240, scale: 2 },
      captureBeyondViewport: false,
      fromSurface: false
    }
    let resolveCapture: ((value: { data: string }) => void) | undefined
    webContents.debugger.sendCommand.mockImplementation(() => {
      if (!resolveCapture) {
        return new Promise<{ data: string }>((resolve) => {
          resolveCapture = resolve
        })
      }
      return Promise.resolve({ data: 'unexpected-second-cdp-capture' })
    })
    webContents.capturePage.mockImplementation(() => {
      resolveCapture?.({ data: 'clipped-jpeg' })
      return Promise.resolve({ isEmpty: () => false })
    })

    const capture = captureScreenshot(webContents.guest, params, noHold)
    await vi.advanceTimersByTimeAsync(250)

    await expect(capture).resolves.toEqual({ data: 'clipped-jpeg' })
    expect(webContents.debugger.sendCommand.mock.calls).toEqual([
      ['Page.captureScreenshot', params]
    ])
    expect(webContents.capturePage).toHaveBeenCalledWith(undefined, {
      stayHidden: true,
      stayAwake: false
    })
  })

  it('stops probing at the deadline', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValue({ isEmpty: () => true })

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const settled = expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(8000)
    await settled

    await vi.advanceTimersByTimeAsync(60_000)
    expect(webContents.debugger.sendCommand.mock.calls).toEqual([
      ['Page.captureScreenshot', { format: 'png' }]
    ])
    expect(webContents.capturePage).toHaveBeenCalledWith(undefined, {
      stayHidden: true,
      stayAwake: false
    })
  })

  it('clears frame probes when the initial CDP send throws synchronously', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => {
      throw new Error('synchronous primary failure')
    })

    await expect(captureScreenshot(webContents.guest, { format: 'png' }, noHold)).rejects.toThrow(
      'synchronous primary failure'
    )
    await vi.advanceTimersByTimeAsync(8000)

    expect(webContents.capturePage).not.toHaveBeenCalled()
    expect(browserCaptureIdle.isIdle(webContents.guest)).toBe(true)
  })
  it('fails at once on a CDP error, without retrying or falling back', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockRejectedValue(new Error('Target closed'))

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const settled = expect(capture).rejects.toThrow('Target closed')
    await vi.advanceTimersByTimeAsync(0)
    await settled

    await vi.advanceTimersByTimeAsync(8000)
    expect(webContents.debugger.sendCommand).toHaveBeenCalledTimes(1)
    expect(webContents.capturePage).not.toHaveBeenCalled()
  })

  it('stops retrying once the guest is destroyed', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const settled = expect(capture).rejects.toThrow('WebContents destroyed')
    await vi.advanceTimersByTimeAsync(0)
    webContents.isDestroyed.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(250)
    await settled

    expect(webContents.debugger.sendCommand).toHaveBeenCalledTimes(1)
  })

  it('reports a detached debugger as detached', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const settled = expect(capture).rejects.toThrow('Debugger detached')
    await vi.advanceTimersByTimeAsync(0)
    webContents.debugger.isAttached.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(250)
    await settled
  })

  it.each(['png', 'jpeg'] as const)(
    'falls back to native %s when Page.captureScreenshot stalls',
    async (format) => {
      vi.useFakeTimers()
      const webContents = createMockWebContents()
      webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
      const toPNG = vi.fn(() => Buffer.from('fallback-png'))
      const toJPEG = vi.fn(() => Buffer.from('fallback-jpeg'))
      let nativePulseCount = 0
      webContents.capturePage.mockImplementation(async () => {
        nativePulseCount += 1
        if (nativePulseCount <= 4) {
          return { isEmpty: () => true }
        }
        return { isEmpty: () => false, toPNG, toJPEG }
      })

      const capture = captureScreenshot(webContents.guest, { format, quality: 37 }, noHold)
      await vi.advanceTimersByTimeAsync(8000)

      await expect(capture).resolves.toEqual({
        data: Buffer.from(`fallback-${format}`).toString('base64')
      })
      if (format === 'jpeg') {
        expect(toJPEG).toHaveBeenCalledWith(37)
        expect(toPNG).not.toHaveBeenCalled()
      } else {
        expect(toPNG).toHaveBeenCalledTimes(1)
        expect(toJPEG).not.toHaveBeenCalled()
      }
      expect(webContents.capturePage).toHaveBeenCalledTimes(5)
    }
  )

  it.each([
    { format: 'png', scale: 1 },
    { format: 'png', scale: 2 },
    { format: 'jpeg', scale: 1 },
    { format: 'jpeg', scale: 2 }
  ] as const)(
    'declines $format fallback clip at scale $scale without encoding another region',
    async ({ format, scale }) => {
      vi.useFakeTimers()
      const toPNG = vi.fn(() => Buffer.from('cropped-png'))
      const toJPEG = vi.fn(() => Buffer.from('cropped-jpeg'))
      const croppedImage = {
        isEmpty: () => false,
        toPNG,
        toJPEG
      }
      const webContents = createMockWebContents()
      webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
      const crop = vi.fn(() => croppedImage)
      let nativePulseCount = 0
      webContents.capturePage.mockImplementation(async () => {
        nativePulseCount += 1
        if (nativePulseCount <= 4) {
          return { isEmpty: () => true }
        }
        return {
          isEmpty: () => false,
          getSize: () => ({ width: 400, height: 300 }),
          crop,
          toPNG,
          toJPEG
        }
      })

      const capture = captureScreenshot(
        webContents.guest,
        { format, clip: { x: 10, y: 20, width: 100, height: 50, scale } },
        noHold
      )
      const settled = capture.then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      )
      await vi.advanceTimersByTimeAsync(8000)
      await expect(settled).resolves.toEqual({ error: new Error(TIMEOUT_MESSAGE) })

      expect(crop).not.toHaveBeenCalled()
      expect(toPNG).not.toHaveBeenCalled()
      expect(toJPEG).not.toHaveBeenCalled()
      expect(webContents.capturePage).toHaveBeenCalledTimes(5)
    }
  )

  it('keeps the timeout error when the request needs beyond-viewport pixels', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({ isEmpty: () => true }).mockResolvedValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 300 }),
      crop: vi.fn(),
      toPNG: () => Buffer.from('full-png')
    })

    const capture = captureScreenshot(
      webContents.guest,
      {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 800, height: 1200, scale: 1 }
      },
      noHold
    )
    const settled = expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(8000)
    await settled
  })

  it('reports the original timeout when the fallback capture is empty', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValue({ isEmpty: () => true })

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const settled = expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(8000)
    await settled
  })

  it('reports the original timeout when fallback encoding fails', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValue({
      isEmpty: () => {
        throw new Error('native image unavailable')
      }
    })

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const settled = expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(8000)
    await settled
  })

  it('reports the timeout without starting fallback capture when a pulse remains unresolved', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockImplementation(() => new Promise(() => {}))

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const settled = expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(8000)

    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
    await settled
  })
})

describe('captureFullPageScreenshot', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports an unanswered layout request as unresponsive, not undrawn', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))

    const capture = captureFullPageScreenshot(webContents.guest, 'png', noHold)
    const settled = expect(capture).rejects.toThrow(
      'Screenshot timed out — the browser page did not respond.'
    )
    await vi.advanceTimersByTimeAsync(8000)
    await settled
  })

  it('releases its paint hold when the page cannot be measured', async () => {
    const release = vi.fn()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockRejectedValue(new Error('Target closed'))

    await expect(
      captureFullPageScreenshot(webContents.guest, 'png', () => release)
    ).rejects.toThrow('Target closed')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it.each(['png', 'jpeg'] as const)(
    'preserves %s full-page geometry in draw-triggering probes',
    async (format) => {
      vi.useFakeTimers()
      const webContents = createMockWebContents()
      const clip = { x: 0, y: 0, width: 640, height: 1280, scale: 1 }
      const params = { format, captureBeyondViewport: true, clip }
      let resolveCapture: ((value: { data: string }) => void) | undefined
      webContents.debugger.sendCommand.mockImplementation((method: string) => {
        if (method === 'Page.getLayoutMetrics') {
          return Promise.resolve({ cssContentSize: { width: 640, height: 1280 } })
        }
        if (!resolveCapture) {
          return new Promise<{ data: string }>((resolve) => {
            resolveCapture = resolve
          })
        }
        return Promise.resolve({ data: 'unexpected second CDP capture' })
      })
      webContents.capturePage.mockImplementationOnce(async () => {
        resolveCapture?.({ data: `${format}-full-page` })
        return { isEmpty: () => true }
      })

      const capture = captureFullPageScreenshot(webContents.guest, format, noHold)
      await vi.advanceTimersByTimeAsync(250)

      await expect(capture).resolves.toEqual({ data: `${format}-full-page`, format })
      expect(webContents.debugger.sendCommand.mock.calls).toEqual([
        ['Page.getLayoutMetrics', {}],
        ['Page.captureScreenshot', params]
      ])
      expect(webContents.capturePage).toHaveBeenCalledWith(undefined, {
        stayHidden: true,
        stayAwake: false
      })
    }
  )

  it('uses cssContentSize so HiDPI pages are captured at the real page size', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation((method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return Promise.resolve({
          cssContentSize: { width: 640.25, height: 1280.75 },
          contentSize: { width: 1280.5, height: 2561.5 }
        })
      }
      if (method === 'Page.captureScreenshot') {
        return Promise.resolve({ data: 'full-page-data' })
      }
      return Promise.resolve({})
    })

    await expect(captureFullPageScreenshot(webContents.guest, 'png', noHold)).resolves.toEqual({
      data: 'full-page-data',
      format: 'png'
    })
    expect(webContents.debugger.sendCommand).toHaveBeenNthCalledWith(1, 'Page.getLayoutMetrics', {})
    expect(webContents.debugger.sendCommand).toHaveBeenNthCalledWith(2, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 641, height: 1281, scale: 1 }
    })
  })

  it('falls back to legacy contentSize when cssContentSize is unavailable', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation((method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return Promise.resolve({
          contentSize: { width: 800, height: 1600 }
        })
      }
      if (method === 'Page.captureScreenshot') {
        return Promise.resolve({ data: 'legacy-full-page-data' })
      }
      return Promise.resolve({})
    })

    await expect(captureFullPageScreenshot(webContents.guest, 'jpeg', noHold)).resolves.toEqual({
      data: 'legacy-full-page-data',
      format: 'jpeg'
    })
    expect(webContents.debugger.sendCommand).toHaveBeenNthCalledWith(2, 'Page.captureScreenshot', {
      format: 'jpeg',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 800, height: 1600, scale: 1 }
    })
  })
})

describe('shared native frame admission', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps an unresolved native pulse from one invocation from overlapping the next on the same guest', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    let resolveFirstCapture: ((value: { data: string }) => void) | undefined
    let resolveSecondCapture: ((value: { data: string }) => void) | undefined
    let resolveNative: (() => void) | undefined
    let screenshotCalls = 0
    webContents.debugger.sendCommand.mockImplementation(() => {
      screenshotCalls += 1
      return new Promise<{ data: string }>((resolve) => {
        if (screenshotCalls === 1) {
          resolveFirstCapture = resolve
        } else {
          resolveSecondCapture = resolve
        }
      })
    })
    webContents.capturePage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveNative = () => resolve({ isEmpty: () => false })
        })
    )

    const first = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(250)
    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
    resolveFirstCapture?.({ data: 'first' })
    await expect(first).resolves.toEqual({ data: 'first' })

    const second = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(250)
    expect(webContents.capturePage).toHaveBeenCalledTimes(1)

    resolveNative?.()
    await vi.advanceTimersByTimeAsync(500)
    expect(webContents.capturePage).toHaveBeenCalledTimes(2)
    resolveSecondCapture?.({ data: 'second' })
    await expect(second).resolves.toEqual({ data: 'second' })
  })

  it('does not launch fallback capturePage while a prior invocation pulse remains unresolved', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    let resolveFirstCapture: ((value: { data: string }) => void) | undefined
    let resolveNative: (() => void) | undefined
    let screenshotCalls = 0
    webContents.debugger.sendCommand.mockImplementation(() => {
      screenshotCalls += 1
      if (screenshotCalls === 1) {
        return new Promise<{ data: string }>((resolve) => {
          resolveFirstCapture = resolve
        })
      }
      return new Promise(() => {})
    })
    webContents.capturePage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveNative = () => resolve({ isEmpty: () => false })
        })
    )

    const first = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(250)
    resolveFirstCapture?.({ data: 'first' })
    await expect(first).resolves.toEqual({ data: 'first' })

    const second = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const settled = expect(second).rejects.toThrow(TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(9000)
    await settled
    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
    resolveNative?.()
  })

  it('admits native pulses independently for distinct guests', async () => {
    vi.useFakeTimers()
    const first = createMockWebContents()
    const second = createMockWebContents()
    first.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    second.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    first.capturePage.mockImplementation(() => new Promise(() => {}))
    second.capturePage.mockImplementation(() => new Promise(() => {}))

    const captureFirst = captureScreenshot(first.guest, { format: 'png' }, noHold)
    const captureSecond = captureScreenshot(second.guest, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(250)
    expect(first.capturePage).toHaveBeenCalledTimes(1)
    expect(second.capturePage).toHaveBeenCalledTimes(1)
    captureFirst.catch(() => {})
    captureSecond.catch(() => {})
  })

  it('releases admission after a rejected or synchronous native capture failure', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    let resolveCapture: ((value: { data: string }) => void) | undefined
    webContents.debugger.sendCommand.mockImplementation(
      () =>
        new Promise<{ data: string }>((resolve) => {
          resolveCapture = resolve
        })
    )
    webContents.capturePage
      .mockImplementationOnce(() => {
        throw new Error('sync failure')
      })
      .mockRejectedValueOnce(new Error('async failure'))
      .mockImplementationOnce(() => Promise.resolve({ isEmpty: () => false }))

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(1750)
    expect(webContents.capturePage).toHaveBeenCalledTimes(3)
    resolveCapture?.({ data: 'primary' })
    await expect(capture).resolves.toEqual({ data: 'primary' })
  })
})
