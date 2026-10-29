import { afterEach, describe, expect, it, vi } from 'vitest'
import { sharedPromiseSettlementWaiters } from '../../../shared/promise-settlement-waiters'
import { RelayReadinessWaiters } from './relay-readiness'

afterEach(() => vi.useRealTimers())

describe('relay readiness wait lifetime', () => {
  it('detaches expired mint callers while shared reconnect work remains pending', async () => {
    vi.useFakeTimers()
    let finish = (): void => {}
    const work = new Promise<void>((resolve) => {
      finish = resolve
    })
    const observed = vi.spyOn(work, 'then')
    const waiters = new RelayReadinessWaiters()
    const anchor = waiters.until(work, Date.now() + 10_000)
    for (let index = 0; index < 100; index += 1) {
      const waiting = waiters.until(work, Date.now() + 1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(waiting).resolves.toBe(false)
    }
    expect(observed).toHaveBeenCalledOnce()
    expect(sharedPromiseSettlementWaiters(work).waiterCount).toBe(1)
    finish()
    await expect(anchor).resolves.toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases callers without cancelling shared work and permits a later wait', async () => {
    vi.useFakeTimers()
    let finish = (): void => {}
    const work = new Promise<void>((resolve) => {
      finish = resolve
    })
    const waiters = new RelayReadinessWaiters()
    const first = waiters.until(work, Date.now() + 10_000)
    waiters.releaseAll()
    await expect(first).resolves.toBe(false)
    expect(sharedPromiseSettlementWaiters(work).waiterCount).toBe(0)
    const next = waiters.until(work, Date.now() + 10_000)
    finish()
    await expect(next).resolves.toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates reconnect failures and clears its deadline', async () => {
    vi.useFakeTimers()
    const error = new Error('reconnect failed')
    await expect(
      new RelayReadinessWaiters().until(Promise.reject(error), Date.now() + 10_000)
    ).rejects.toBe(error)
    expect(vi.getTimerCount()).toBe(0)
  })
})
