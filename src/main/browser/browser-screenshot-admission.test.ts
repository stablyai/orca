import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetBrowserScreenshotAdmissionForTests,
  startBrowserFallbackCapture,
  startBrowserScreenshotCommand
} from './browser-screenshot-admission'
import { BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES } from './browser-screenshot-limits'

function deferred<T>(): {
  promise: Promise<T>
  reject: (error: Error) => void
  resolve: (value: T) => void
} {
  let reject!: (error: Error) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, reject, resolve }
}

function createWebContents() {
  const events = new EventEmitter()
  return Object.assign(events, {
    capturePage: vi.fn(),
    debugger: { sendCommand: vi.fn() }
  })
}

afterEach(() => {
  resetBrowserScreenshotAdmissionForTests()
})

describe('browser screenshot admission', () => {
  it('caps native capture work across different WebContents and releases on settlement', async () => {
    const operations = Array.from({ length: BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES }, () =>
      deferred<unknown>()
    )
    const contents = operations.map((operation) => {
      const webContents = createWebContents()
      webContents.debugger.sendCommand.mockReturnValue(operation.promise)
      return webContents
    })
    const active = contents.map((webContents) =>
      startBrowserScreenshotCommand(webContents as never, 'Page.captureScreenshot', {})
    )

    const overflow = createWebContents()
    overflow.debugger.sendCommand.mockResolvedValue({ data: 'later' })
    expect(
      startBrowserScreenshotCommand(overflow as never, 'Page.captureScreenshot', {})
    ).toBeNull()

    operations[0]!.resolve({ data: 'first' })
    await expect(active[0]).resolves.toEqual({ data: 'first' })
    await expect(
      startBrowserScreenshotCommand(overflow as never, 'Page.captureScreenshot', {})
    ).resolves.toEqual({ data: 'later' })

    operations[1]!.reject(new Error('capture failed'))
    await expect(active[1]).rejects.toThrow('capture failed')
  })

  it('shares admission with fallback capture and releases synchronous failures', async () => {
    const commandContents = createWebContents()
    commandContents.debugger.sendCommand.mockImplementation(() => {
      throw new Error('sync failure')
    })
    await expect(
      startBrowserScreenshotCommand(commandContents as never, 'Page.captureScreenshot', {})
    ).rejects.toThrow('sync failure')

    const fallbackContents = createWebContents()
    const image = { isEmpty: () => false }
    fallbackContents.capturePage.mockResolvedValue(image)
    await expect(startBrowserFallbackCapture(fallbackContents as never)).resolves.toBe(image)
  })

  it('releases a hung operation when its WebContents is destroyed', async () => {
    const hung = createWebContents()
    hung.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    expect(
      startBrowserScreenshotCommand(hung as never, 'Page.captureScreenshot', {})
    ).not.toBeNull()
    hung.emit('destroyed')

    const replacement = createWebContents()
    replacement.debugger.sendCommand.mockResolvedValue({ data: 'replacement' })
    await expect(
      startBrowserScreenshotCommand(replacement as never, 'Page.captureScreenshot', {})
    ).resolves.toEqual({ data: 'replacement' })
  })
})
