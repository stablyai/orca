import { describe, expect, it, vi } from 'vitest'

import { browserCaptureIdle } from './browser-capture-idle'
import { captureSelectionScreenshot } from './browser-grab-screenshot'
import { createOwnedViewFixture } from './desktop-owned-browser-view-test-fixture'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('browser grab capture idle participation', () => {
  it('returns no screenshot without touching a surface reserved for native layout', async () => {
    const fixture = createOwnedViewFixture()
    const capturePage = vi.fn()
    const executeJavaScript = vi.fn()
    Object.assign(fixture.guest, { capturePage, executeJavaScript })
    const lease = await browserCaptureIdle.reserve(fixture.record.webContents)
    try {
      await expect(
        captureSelectionScreenshot(
          { x: 0, y: 0, width: 10, height: 10 },
          fixture.record.webContents
        )
      ).resolves.toBeNull()
      expect(capturePage).not.toHaveBeenCalled()
      expect(executeJavaScript).not.toHaveBeenCalled()
    } finally {
      lease.release()
      await fixture.controller.close()
    }
  })

  it('holds the entire hide, native capture, and restore transaction before a reservation can move', async () => {
    const native = deferred<Electron.NativeImage>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies both guest APIs used by selection capture.
    const guest = {
      executeJavaScript: vi.fn((script: string) =>
        Promise.resolve(script === 'window.innerWidth' ? 100 : undefined)
      ),
      capturePage: vi.fn(() => native.promise)
    } as unknown as Electron.WebContents
    const screenshot = captureSelectionScreenshot({ x: 0, y: 0, width: 10, height: 10 }, guest)
    const reservation = browserCaptureIdle.reserve(guest)

    expect(() => browserCaptureIdle.assertCaptureAllowed(guest)).toThrow('reserved')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection capture reads only size, emptiness, crop and PNG encoding from this image fixture.
    native.resolve({
      isEmpty: () => false,
      getSize: () => ({ width: 100, height: 100 }),
      crop: () => ({ toPNG: () => Buffer.from('png') })
    } as unknown as Electron.NativeImage)

    await expect(screenshot).resolves.toMatchObject({ width: 10, height: 10 })
    const lease = await reservation
    expect(guest.executeJavaScript).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('__orcaGrab')
    )
    expect(guest.executeJavaScript).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('__orcaGrab')
    )
    lease.release()
  })
})
