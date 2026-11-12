import { afterEach, describe, expect, it, vi } from 'vitest'
import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
import { RelayReadinessWaiters } from './relay-readiness'

afterEach(() => vi.useRealTimers())

describe('relay readiness wait lifetime', () => {
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
})
