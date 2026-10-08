import { describe, expect, it } from 'vitest'

import { BrowserCaptureIdle } from './browser-capture-idle'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('BrowserCaptureIdle', () => {
  it('queues capture admission until the lifecycle reservation is released', async () => {
    const idle = new BrowserCaptureIdle()
    const target = {}
    const lease = await idle.reserve(target)
    let ran = false
    const queued = idle.runWhenCaptureAllowed(target, async () => {
      ran = true
      return 'admitted'
    })
    await Promise.resolve()
    expect(ran).toBe(false)
    lease.release()
    await expect(queued).resolves.toBe('admitted')
    expect(ran).toBe(true)
  })

  it('rechecks admission when another reservation is taken before a queued capture resumes', async () => {
    const idle = new BrowserCaptureIdle()
    const target = {}
    const lease = await idle.reserve(target)
    let ran = false
    const queued = idle.runWhenCaptureAllowed(target, async () => {
      ran = true
    })
    lease.release()
    const replacement = await idle.reserve(target)
    await Promise.resolve()
    expect(ran).toBe(false)
    replacement.release()
    await queued
    expect(ran).toBe(true)
  })

  it('remains busy after a primary caller settles until its native operation actually settles', async () => {
    const idle = new BrowserCaptureIdle()
    const webContents = {}
    const primary = deferred<void>()
    const native = deferred<void>()
    idle.trackPrimary(webContents, primary.promise)
    idle.trackNative(webContents, native.promise)

    primary.resolve()
    await primary.promise
    expect(idle.isIdle(webContents)).toBe(false)

    const settled = idle.waitForIdle(webContents)
    native.resolve()
    await settled
    expect(idle.isIdle(webContents)).toBe(true)
  })

  it('releases waiters after a rejected native operation settles', async () => {
    const idle = new BrowserCaptureIdle()
    const webContents = {}
    const native = deferred<void>()
    idle.trackNative(webContents, native.promise)
    const settled = idle.waitForIdle(webContents)
    native.reject(new Error('native failure'))
    await settled
    expect(idle.isIdle(webContents)).toBe(true)
  })

  it('blocks a new capture atomically while a lifecycle reservation waits for prior work', async () => {
    const idle = new BrowserCaptureIdle()
    const webContents = {}
    const primary = deferred<void>()
    idle.trackPrimary(webContents, primary.promise)
    const reservation = idle.reserve(webContents)

    expect(() => idle.assertCaptureAllowed(webContents)).toThrow('reserved')
    primary.resolve()
    const acquired = await reservation
    expect(() => idle.assertCaptureAllowed(webContents)).toThrow('reserved')
    acquired.release()
    expect(() => idle.assertCaptureAllowed(webContents)).not.toThrow()
  })

  it('admits only the exact reservation token to a reserved capture', async () => {
    const idle = new BrowserCaptureIdle()
    const webContents = {}
    const reservation = await idle.reserve(webContents)

    expect(() => idle.assertCaptureAllowed(webContents)).toThrow('reserved')
    expect(() => idle.assertCaptureAllowed(webContents, { ...reservation })).toThrow('not active')
    await expect(
      idle.runReservedCapture(webContents, reservation, async (token) => {
        expect(() => idle.assertCaptureAllowed(webContents, token)).not.toThrow()
      })
    ).resolves.toBeUndefined()
    reservation.release()
    expect(() => idle.assertCaptureAllowed(webContents, reservation)).toThrow('not active')
  })

  it('keeps an admitted operation busy across asynchronous stages with no native promise yet', async () => {
    const idle = new BrowserCaptureIdle()
    const target = {}
    const layout = deferred<void>()
    const frame = deferred<void>()
    const operation = idle.runCapture(target, async () => {
      await layout.promise
      await Promise.resolve()
      await idle.trackNative(target, frame.promise)
    })
    let reserved = false
    const pendingReservation = idle.reserve(target).then((lease) => {
      reserved = true
      return lease
    })
    expect(() => idle.assertCaptureAllowed(target)).toThrow('reserved')
    layout.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(reserved).toBe(false)
    frame.resolve()
    await operation
    const lease = await pendingReservation
    expect(reserved).toBe(true)
    lease.release()
  })

  it('cannot release a reservation while its authorized operation is active', async () => {
    const idle = new BrowserCaptureIdle()
    const target = {}
    const lease = await idle.reserve(target)
    const work = deferred<void>()
    const running = idle.runReservedCapture(target, lease, () => work.promise)
    expect(() => lease.release()).toThrow('pending operations')
    work.resolve()
    await running
    lease.release()
  })

  it('lets a pre-reservation operation issue later work, but denies a new caller', async () => {
    const idle = new BrowserCaptureIdle()
    const target = {}
    const continueOuter = deferred<void>()
    const outer = idle.runCapture(target, async () => {
      await continueOuter.promise
      expect(() => idle.assertCaptureAllowed(target)).not.toThrow()
    })
    const reservation = idle.reserve(target)

    expect(() => idle.assertCaptureAllowed(target)).toThrow('reserved')
    continueOuter.resolve()
    await outer
    const lease = await reservation
    lease.release()
  })

  it('does not let a timer inherit admission after its outer operation retires', async () => {
    const idle = new BrowserCaptureIdle()
    const target = {}
    let afterReturn!: Promise<void>
    await idle.runCapture(target, async () => {
      afterReturn = new Promise((resolve) => {
        setImmediate(() => {
          expect(() => idle.assertCaptureAllowed(target)).toThrow('reserved')
          resolve()
        })
      })
    })
    const lease = await idle.reserve(target)

    await afterReturn
    lease.release()
  })

  it('rejects a forged reservation even inside an operation admitted before reserve', async () => {
    const idle = new BrowserCaptureIdle()
    const target = {}
    const continueOuter = deferred<void>()
    const outer = idle.runCapture(target, async () => {
      await continueOuter.promise
      expect(() => idle.assertCaptureAllowed(target, { id: Symbol(), release: () => {} })).toThrow(
        'not active'
      )
    })
    const reservation = idle.reserve(target)

    continueOuter.resolve()
    await outer
    const lease = await reservation
    lease.release()
  })
})
