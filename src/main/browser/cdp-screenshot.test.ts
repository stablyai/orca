import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureFullPageScreenshot, captureScreenshot } from './cdp-screenshot'
import { resetBrowserScreenshotAdmissionForTests } from './browser-screenshot-admission'
import {
  BROWSER_SCREENSHOT_BUSY_ERROR,
  BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES,
  BROWSER_SCREENSHOT_MAX_DIMENSION_PX,
  BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR
} from './browser-screenshot-limits'

function createMockWebContents() {
  return {
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: vi.fn(() => false),
    invalidate: vi.fn(),
    capturePage: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => true),
      sendCommand: vi.fn()
    }
  }
}

describe('captureScreenshot', () => {
  afterEach(() => {
    resetBrowserScreenshotAdmissionForTests()
    vi.useRealTimers()
  })

  it('invalidates the guest before forwarding Page.captureScreenshot', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockResolvedValueOnce({ data: 'png-data' })
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await Promise.resolve()

    expect(webContents.invalidate).toHaveBeenCalledTimes(1)
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png'
    })
    expect(onResult).toHaveBeenCalledWith({ data: 'png-data' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('rejects concurrent capture overload without retaining another native promise', async () => {
    const webContents = createMockWebContents()
    const resolvers: ((result: { data: string }) => void)[] = []
    webContents.debugger.sendCommand.mockImplementation(
      () =>
        new Promise<{ data: string }>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const results = Array.from({ length: BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES + 1 }, () =>
      vi.fn()
    )
    const errors = results.map(() => vi.fn())

    for (let index = 0; index < results.length; index += 1) {
      captureScreenshot(webContents as never, { format: 'png' }, results[index]!, errors[index]!)
    }
    await Promise.resolve()
    await Promise.resolve()

    expect(webContents.debugger.sendCommand).toHaveBeenCalledTimes(
      BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES
    )
    expect(errors.at(-1)).toHaveBeenCalledWith(BROWSER_SCREENSHOT_BUSY_ERROR)
    for (const resolve of resolvers) {
      resolve({ data: 'cG5n' })
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(
      results
        .slice(0, BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES)
        .every((callback) => callback.mock.calls.length === 1)
    ).toBe(true)
  })

  it('keeps timed-out native captures admitted until Chromium actually settles', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      toPNG: () => Buffer.from('fallback-png')
    })
    const results = Array.from({ length: BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES }, () =>
      vi.fn()
    )
    const errors = results.map(() => vi.fn())

    for (let index = 0; index < results.length; index += 1) {
      captureScreenshot(webContents as never, { format: 'png' }, results[index]!, errors[index]!)
    }
    await vi.advanceTimersByTimeAsync(8000)

    expect(results.every((callback) => callback.mock.calls.length === 0)).toBe(true)
    expect(
      errors.every((callback) => callback.mock.calls[0]?.[0] === BROWSER_SCREENSHOT_BUSY_ERROR)
    ).toBe(true)
    expect(webContents.capturePage).not.toHaveBeenCalled()
    const overloadError = vi.fn()
    captureScreenshot(webContents as never, { format: 'png' }, vi.fn(), overloadError)
    expect(overloadError).toHaveBeenCalledWith(BROWSER_SCREENSHOT_BUSY_ERROR)
    expect(webContents.debugger.sendCommand).toHaveBeenCalledTimes(
      BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES
    )
  })

  it('retains admission for a fallback that outlives the failed CDP capture', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    const commandRejectors: ((error: Error) => void)[] = []
    webContents.debugger.sendCommand.mockImplementation(
      () =>
        new Promise((_, reject) => {
          commandRejectors.push(reject)
        })
    )
    webContents.capturePage.mockImplementation(() => new Promise(() => {}))
    const firstError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, vi.fn(), firstError)
    await vi.advanceTimersByTimeAsync(8000)
    commandRejectors[0]!(new Error('CDP failed after timeout'))
    await Promise.resolve()
    await Promise.resolve()

    expect(firstError).toHaveBeenCalledWith('CDP failed after timeout')
    const secondError = vi.fn()
    captureScreenshot(webContents as never, { format: 'png' }, vi.fn(), secondError)
    await vi.advanceTimersByTimeAsync(8000)

    expect(secondError).toHaveBeenCalledWith(BROWSER_SCREENSHOT_BUSY_ERROR)
    expect(webContents.capturePage).toHaveBeenCalledOnce()
  })

  it('falls back to capturePage when Page.captureScreenshot stalls', async () => {
    vi.useFakeTimers()

    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      toPNG: () => Buffer.from('fallback-png')
    })
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await vi.advanceTimersByTimeAsync(8000)

    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith({
      data: Buffer.from('fallback-png').toString('base64')
    })
    expect(onError).not.toHaveBeenCalled()
  })

  it('crops the fallback image when the request includes a visible clip rect', async () => {
    vi.useFakeTimers()

    const croppedImage = {
      isEmpty: () => false,
      getSize: () => ({ width: 60, height: 80 }),
      toPNG: () => Buffer.from('cropped-png')
    }
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 300 }),
      crop: vi.fn(() => croppedImage),
      toPNG: () => Buffer.from('full-png')
    })
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(
      webContents as never,
      {
        format: 'png',
        clip: { x: 10, y: 20, width: 30, height: 40, scale: 2 }
      },
      onResult,
      onError
    )
    await vi.advanceTimersByTimeAsync(8000)

    const fallbackImage = await webContents.capturePage.mock.results[0]?.value
    expect(fallbackImage.crop).toHaveBeenCalledWith({ x: 20, y: 40, width: 60, height: 80 })
    expect(onResult).toHaveBeenCalledWith({
      data: Buffer.from('cropped-png').toString('base64')
    })
    expect(onError).not.toHaveBeenCalled()
  })

  it('keeps the timeout error when the request needs beyond-viewport pixels', async () => {
    vi.useFakeTimers()

    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 300 }),
      crop: vi.fn(),
      toPNG: () => Buffer.from('full-png')
    })
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(
      webContents as never,
      {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 800, height: 1200, scale: 1 }
      },
      onResult,
      onError
    )
    await vi.advanceTimersByTimeAsync(8000)

    expect(onResult).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'
    )
  })

  it('rejects an oversized clip before asking Chromium to capture it', () => {
    const webContents = createMockWebContents()
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(
      webContents as never,
      {
        format: 'png',
        clip: { x: 0, y: 0, width: BROWSER_SCREENSHOT_MAX_DIMENSION_PX + 1, height: 1 }
      },
      onResult,
      onError
    )

    expect(onError).toHaveBeenCalledWith(BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR)
    expect(onResult).not.toHaveBeenCalled()
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('rejects an oversized fallback bitmap before encoding it', async () => {
    vi.useFakeTimers()
    const toPNG = vi.fn(() => Buffer.from('unused'))
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: BROWSER_SCREENSHOT_MAX_DIMENSION_PX + 1, height: 1 }),
      toPNG
    })
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await vi.advanceTimersByTimeAsync(8000)

    expect(onError).toHaveBeenCalledWith(BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR)
    expect(onResult).not.toHaveBeenCalled()
    expect(toPNG).not.toHaveBeenCalled()
  })

  it('ignores the fallback result when CDP settles first after the timeout fires', async () => {
    vi.useFakeTimers()

    let resolveCapturePage: ((value: unknown) => void) | null = null
    let resolveSendCommand: ((value: unknown) => void) | null = null
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSendCommand = resolve
        })
    )
    webContents.capturePage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapturePage = resolve
        })
    )
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await vi.advanceTimersByTimeAsync(8000)

    expect(resolveSendCommand).toBeTypeOf('function')
    resolveSendCommand!({ data: 'cdp-png' })
    await Promise.resolve()

    expect(resolveCapturePage).toBeTypeOf('function')
    resolveCapturePage!({
      isEmpty: () => false,
      getSize: () => ({ width: 100, height: 100 }),
      crop: vi.fn(),
      toPNG: () => Buffer.from('fallback-png')
    })
    await Promise.resolve()

    expect(onResult).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith({ data: 'cdp-png' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports the original timeout when the fallback capture is unavailable', async () => {
    vi.useFakeTimers()

    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => true,
      toPNG: () => Buffer.from('unused')
    })
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await vi.advanceTimersByTimeAsync(8000)

    expect(onResult).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'
    )
  })

  it('reports the original timeout when fallback encoding fails', async () => {
    vi.useFakeTimers()

    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => {
        throw new Error('native image unavailable')
      }
    })
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await vi.advanceTimersByTimeAsync(8000)

    expect(onResult).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'
    )
  })

  it('reports the timeout when both CDP and fallback capture stall', async () => {
    vi.useFakeTimers()

    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockImplementation(() => new Promise(() => {}))
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await vi.advanceTimersByTimeAsync(8000)

    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
    expect(onResult).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)

    expect(onError).toHaveBeenCalledWith(
      'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'
    )
  })
})

describe('captureFullPageScreenshot', () => {
  afterEach(() => {
    resetBrowserScreenshotAdmissionForTests()
    vi.useRealTimers()
  })

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

    await expect(captureFullPageScreenshot(webContents as never, 'png')).resolves.toEqual({
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

    await expect(captureFullPageScreenshot(webContents as never, 'jpeg')).resolves.toEqual({
      data: 'legacy-full-page-data',
      format: 'jpeg'
    })
    expect(webContents.debugger.sendCommand).toHaveBeenNthCalledWith(2, 'Page.captureScreenshot', {
      format: 'jpeg',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 800, height: 1600, scale: 1 }
    })
  })

  it('rejects oversized full-page layout bounds before capture allocation', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockResolvedValueOnce({
      cssContentSize: { width: BROWSER_SCREENSHOT_MAX_DIMENSION_PX + 1, height: 1 }
    })

    await expect(captureFullPageScreenshot(webContents as never, 'png')).rejects.toThrow(
      BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR
    )
    expect(webContents.debugger.sendCommand).toHaveBeenCalledOnce()
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.getLayoutMetrics', {})
  })

  it('bounds hung full-page metric commands across logical timeouts', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    const active = Array.from({ length: BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES }, () =>
      captureFullPageScreenshot(webContents as never, 'png')
    )
    const activeAssertions = active.map((capture) =>
      expect(capture).rejects.toThrow(
        'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'
      )
    )

    await expect(captureFullPageScreenshot(webContents as never, 'png')).rejects.toThrow(
      BROWSER_SCREENSHOT_BUSY_ERROR
    )
    await vi.advanceTimersByTimeAsync(8000)
    await Promise.all(activeAssertions)
    await expect(captureFullPageScreenshot(webContents as never, 'png')).rejects.toThrow(
      BROWSER_SCREENSHOT_BUSY_ERROR
    )
    expect(webContents.debugger.sendCommand).toHaveBeenCalledTimes(
      BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES
    )
  })
})
