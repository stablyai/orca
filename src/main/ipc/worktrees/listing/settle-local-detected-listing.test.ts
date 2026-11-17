import { afterEach, describe, expect, it, vi } from 'vitest'
import { settleLocalDetectedListingWithin } from './settle-local-detected-listing'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('settleLocalDetectedListingWithin', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the listing result when it settles before the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onTimeout = vi.fn()
    const { promise, resolve } = deferred<string>()
    const settled = settleLocalDetectedListingWithin(promise, 30_000, onTimeout)
    resolve('rows')
    await expect(settled).resolves.toBe('rows')
    vi.advanceTimersByTime(30_000)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('resolves null and reports when the listing never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onTimeout = vi.fn()
    const { promise } = deferred<string>()
    const settled = settleLocalDetectedListingWithin(promise, 30_000, onTimeout)
    vi.advanceTimersByTime(29_999)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await expect(settled).resolves.toBeNull()
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('a late listing rejection after the deadline is not an unhandled rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const onTimeout = vi.fn()
      const { promise, reject } = deferred<string>()
      const settled = settleLocalDetectedListingWithin(promise, 30_000, onTimeout)
      vi.advanceTimersByTime(30_000)
      await expect(settled).resolves.toBeNull()
      reject(new Error('git failed after the deadline'))
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('the deadline timer stops once the listing settles first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onTimeout = vi.fn()
    const { promise, resolve } = deferred<string>()
    const settled = settleLocalDetectedListingWithin(promise, 30_000, onTimeout)
    resolve('rows')
    await expect(settled).resolves.toBe('rows')
    vi.advanceTimersByTime(120_000)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
