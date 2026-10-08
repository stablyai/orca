import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import { browserCaptureIdle } from './browser-capture-idle'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'
import { createBrowserScreencastSnapshotCapture } from './browser-screencast-snapshot-capture'
import { createOwnedViewFixture } from './desktop-owned-browser-view-test-fixture'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('screencast capture idle participation', () => {
  it('keeps the raw native capture busy after snapshot timeout and fallback completion', async () => {
    vi.useFakeTimers()
    const raw = deferred<unknown>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot and idle gate use only these supplied guest and debugger methods.
    const webContents = {
      isDestroyed: vi.fn(() => false),
      isCrashed: vi.fn(() => false),
      capturePage: vi.fn(() => raw.promise),
      debugger: {
        sendCommand: vi.fn(async () => ({ data: Buffer.from('fallback').toString('base64') }))
      }
    } as unknown as Electron.WebContents
    const queueFrame = vi.fn()
    const capture = createBrowserScreencastSnapshotCapture({
      webContents,
      dbg: webContents.debugger,
      options: {
        format: 'png',
        quality: 80,
        maxWidth: 100,
        maxHeight: 100,
        viewportWidth: 100,
        viewportHeight: 100,
        everyNthFrame: 1,
        minFrameIntervalMs: 0,
        onFrame: () => {}
      },
      isClosed: () => false,
      isStopping: () => false,
      getSeq: () => 0,
      queueFrame,
      applyDeviceMetricsOverride: async () => {}
    })
    try {
      const snapshot = capture.emitSnapshotFrame(true)
      await vi.advanceTimersByTimeAsync(10_000)
      await snapshot
      expect(queueFrame).toHaveBeenCalledTimes(1)
      expect(Buffer.from(queueFrame.mock.calls[0][0].image).toString()).toBe('fallback')
      let reserved = false
      const reservation = browserCaptureIdle.reserve(webContents).then((lease) => {
        reserved = true
        return lease
      })
      await vi.advanceTimersByTimeAsync(1)
      expect(reserved).toBe(false)
      expect(() => browserCaptureIdle.assertCaptureAllowed(webContents)).toThrow('reserved')
      raw.resolve({
        toPNG: () => Buffer.from('late'),
        getSize: () => ({ width: 100, height: 100 })
      })
      const lease = await reservation
      expect(queueFrame).toHaveBeenCalledTimes(1)
      lease.release()
    } finally {
      raw.resolve(undefined)
      vi.useRealTimers()
    }
  })

  it('drops a best-effort frame when a native lifecycle owns the surface', async () => {
    const fixture = createOwnedViewFixture()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reservation refuses this fixture before any Debugger API can run.
    const dbg = {} as Electron.Debugger
    const applyDeviceMetricsOverride = vi.fn(async () => {})
    const queueFrame = vi.fn()
    const capture = createBrowserScreencastSnapshotCapture({
      webContents: fixture.record.webContents,
      dbg,
      options: {
        format: 'png',
        quality: 80,
        maxWidth: 100,
        maxHeight: 100,
        everyNthFrame: 1,
        minFrameIntervalMs: 0,
        onFrame: () => {}
      },
      isClosed: () => false,
      isStopping: () => false,
      getSeq: () => 0,
      queueFrame,
      applyDeviceMetricsOverride
    })
    const lease = await browserCaptureIdle.reserve(fixture.record.webContents)
    try {
      await expect(capture.emitSnapshotFrame(true)).resolves.toBeUndefined()
      expect(applyDeviceMetricsOverride).not.toHaveBeenCalled()
      expect(queueFrame).not.toHaveBeenCalled()
    } finally {
      lease.release()
      await fixture.controller.close()
    }
  })

  it('keeps a timed-out fallback command busy until the raw CDP promise settles', async () => {
    vi.useFakeTimers()
    try {
      const raw = deferred<unknown>()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test exercises only the debugger's supplied sendCommand method.
      const dbg = { sendCommand: vi.fn(() => raw.promise) } as unknown as Electron.Debugger
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies exactly the guest fields used by the admission gate.
      const webContents = {
        isDestroyed: vi.fn(() => false),
        isCrashed: vi.fn(() => false),
        debugger: dbg
      } as unknown as Electron.WebContents
      const fallback = sendDebuggerCommand(dbg, 'Page.captureScreenshot', {}, webContents)
      const timedOut = expect(fallback).rejects.toThrow('Timed out')

      await vi.advanceTimersByTimeAsync(8_000)
      await timedOut
      const reservation = browserCaptureIdle.reserve(webContents)
      expect(() => browserCaptureIdle.assertCaptureAllowed(webContents)).toThrow('reserved')

      raw.resolve({ data: 'late-frame' })
      const lease = await reservation
      lease.release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the legacy three-argument command form untracked', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the legacy command wrapper calls only the supplied sendCommand method.
    const dbg = {
      sendCommand: vi.fn(async () => ({ data: 'frame' }))
    } as unknown as Electron.Debugger

    await expect(
      sendDebuggerCommand(dbg, 'Page.captureScreenshot', { format: 'png' })
    ).resolves.toEqual({
      data: 'frame'
    })
    expect(dbg.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', { format: 'png' })
  })

  it('does not issue a supplied-guest command while the guest is reserved', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies exactly the guest fields used by the admission gate.
    const dbg = {
      sendCommand: vi.fn(async () => ({ data: 'frame' }))
    } as unknown as Electron.Debugger
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies exactly the guest fields used by the admission gate.
    const webContents = {
      isDestroyed: vi.fn(() => false),
      isCrashed: vi.fn(() => false),
      debugger: dbg
    } as unknown as Electron.WebContents
    const lease = await browserCaptureIdle.reserve(webContents)

    await expect(
      sendDebuggerCommand(dbg, 'Page.captureScreenshot', {}, webContents)
    ).rejects.toThrow('reserved')
    expect(dbg.sendCommand).not.toHaveBeenCalled()
    lease.release()
  })
})
