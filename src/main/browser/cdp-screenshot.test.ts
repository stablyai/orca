import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureFullPageScreenshot, captureScreenshot } from './cdp-screenshot'

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
const PROBE = {
  format: 'jpeg',
  quality: 1,
  clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 }
}
const TIMEOUT_MESSAGE = 'Screenshot timed out — the browser page did not draw a frame.'

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

  it('sends the capture once and probes until the held page produces a frame', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    // Undrawn: the capture hangs until a later request makes the page draw a frame.
    let drawFrame: (() => void) | null = null
    webContents.debugger.sendCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            drawFrame = () => resolve({ data: 'drawn-png' })
          })
      )
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => {
        drawFrame?.()
        return Promise.resolve({ data: 'probe' })
      })

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(750)

    await expect(capture).resolves.toEqual({ data: 'drawn-png' })
    expect(webContents.debugger.sendCommand.mock.calls).toEqual([
      ['Page.captureScreenshot', { format: 'png' }],
      ['Page.captureScreenshot', PROBE],
      ['Page.captureScreenshot', PROBE]
    ])
    expect(webContents.capturePage).not.toHaveBeenCalled()
  })

  it('never repeats the full capture while a slow one is in flight', async () => {
    vi.useFakeTimers()
    let resolveCapture: ((value: unknown) => void) | null = null
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCapture = resolve
          })
      )
      .mockImplementation(() => new Promise(() => {}))
    const fullPage = { format: 'png', captureBeyondViewport: true }

    const capture = captureScreenshot(webContents.guest, fullPage, noHold)
    await vi.advanceTimersByTimeAsync(480)
    resolveCapture!({ data: 'slow-png' })

    await expect(capture).resolves.toEqual({ data: 'slow-png' })
    expect(webContents.debugger.sendCommand.mock.calls).toEqual([
      ['Page.captureScreenshot', fullPage],
      ['Page.captureScreenshot', PROBE]
    ])
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
      ['Page.captureScreenshot', { format: 'png' }],
      ['Page.captureScreenshot', PROBE],
      ['Page.captureScreenshot', PROBE],
      ['Page.captureScreenshot', PROBE],
      ['Page.captureScreenshot', PROBE]
    ])
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

  it('falls back to capturePage when Page.captureScreenshot stalls', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      toPNG: () => Buffer.from('fallback-png')
    })

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(8000)

    await expect(capture).resolves.toEqual({
      data: Buffer.from('fallback-png').toString('base64')
    })
    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
  })

  it('crops the fallback image when the request includes a visible clip rect', async () => {
    vi.useFakeTimers()
    const croppedImage = {
      isEmpty: () => false,
      toPNG: () => Buffer.from('cropped-png')
    }
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    const crop = vi.fn(() => croppedImage)
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 300 }),
      crop,
      toPNG: () => Buffer.from('full-png')
    })

    const capture = captureScreenshot(
      webContents.guest,
      { format: 'png', clip: { x: 10, y: 20, width: 100, height: 50, scale: 2 } },
      noHold
    )
    await vi.advanceTimersByTimeAsync(8000)

    await expect(capture).resolves.toEqual({
      data: Buffer.from('cropped-png').toString('base64')
    })
    expect(crop).toHaveBeenCalledWith({ x: 20, y: 40, width: 200, height: 100 })
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
    webContents.capturePage.mockResolvedValueOnce({ isEmpty: () => true })

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const settled = expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(8000)
    await settled
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

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    const settled = expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(8000)
    await settled
  })

  it('reports the timeout when both CDP and fallback capture stall', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockImplementation(() => new Promise(() => {}))
    const onSettled = vi.fn()

    const capture = captureScreenshot(webContents.guest, { format: 'png' }, noHold)
    capture.catch(onSettled)
    await vi.advanceTimersByTimeAsync(8000)
    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
    expect(onSettled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    await expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
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
