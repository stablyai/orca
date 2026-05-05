import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureFullPageScreenshot, captureScreenshot } from './cdp-screenshot'

function createMockWebContents() {
  return {
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

  it('falls back to capturePage when Page.captureScreenshot stalls', async () => {
    vi.useFakeTimers()

    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
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
})

describe('captureFullPageScreenshot', () => {
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
})
