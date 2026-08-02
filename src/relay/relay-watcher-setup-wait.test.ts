import { describe, expect, it, vi } from 'vitest'
import { PromiseSettlementWaiters } from '../shared/promise-settlement-waiters'
import { awaitRelayWatcherSetup } from './relay-watcher-setup-wait'

describe('awaitRelayWatcherSetup', () => {
  it('removes ten thousand cancelled relay callers while one anchor remains', async () => {
    let resolveSetup: () => void = () => undefined
    const setupPromise = new Promise<void>((resolve) => {
      resolveSetup = resolve
    })
    const thenSpy = vi.spyOn(setupPromise, 'then')
    const setupWaiters = new PromiseSettlementWaiters(setupPromise)
    const anchor = awaitRelayWatcherSetup(setupWaiters)
    const controllers = Array.from({ length: 10_000 }, () => new AbortController())
    const cancelled = controllers.map((controller) =>
      awaitRelayWatcherSetup(setupWaiters, controller.signal).catch((error) => error)
    )

    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(cancelled)

    expect(setupWaiters.waiterCount).toBe(1)
    expect(thenSpy).toHaveBeenCalledOnce()
    resolveSetup()
    await expect(anchor).resolves.toBeUndefined()
    expect(setupWaiters.waiterCount).toBe(0)
  })
})
