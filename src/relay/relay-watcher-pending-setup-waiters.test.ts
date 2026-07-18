import { describe, expect, it, vi } from 'vitest'
import type { WatcherProcessSubscription } from '../main/ipc/parcel-watcher-process-subscription'
import type { PromiseSettlementWaiters } from '../shared/promise-settlement-waiters'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { RelayFilesystemWatchRegistry } from './relay-filesystem-watch-registry'

class PendingSetupPool {
  readonly installed: { unsubscribe: () => Promise<void> }[] = []
  readonly dispose = vi.fn()
  readonly forgetRoot = vi.fn()

  async subscribe(): Promise<WatcherProcessSubscription> {
    const subscription = { unsubscribe: vi.fn(async () => undefined) }
    this.installed.push(subscription)
    return subscription
  }
}

function context(clientId: number, signal?: AbortSignal): RequestContext {
  return { clientId, isStale: () => false, signal }
}

describe('RelayFilesystemWatchRegistry pending setup waiters', () => {
  it('removes ten thousand aborted callers queued behind one teardown anchor', async () => {
    const pool = new PendingSetupPool()
    const dispatcher = { notify: vi.fn(), onClientDetached: vi.fn() }
    const registry = new RelayFilesystemWatchRegistry(
      dispatcher as unknown as RelayDispatcher,
      pool
    )
    await registry.watch('/repo', context(1))
    let releaseTeardown: () => void = () => undefined
    pool.installed[0].unsubscribe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseTeardown = resolve
        })
    )
    const teardown = registry.unwatchAndWait('/repo', context(1))
    const leader = registry.watch('/repo', context(2))
    const anchorController = new AbortController()
    const anchor = registry.watch('/repo', context(3, anchorController.signal))
    const controllers = Array.from({ length: 10_000 }, () => new AbortController())
    const cancelled = controllers.map((controller, index) =>
      registry.watch('/repo', context(index + 4, controller.signal))
    )

    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(cancelled)

    const pendingSetups = (
      registry as unknown as { pendingSetups: Map<string, PromiseSettlementWaiters<void>> }
    ).pendingSetups
    expect(pendingSetups.values().next().value?.waiterCount).toBe(1)
    expect(pool.installed).toHaveLength(1)
    releaseTeardown()
    await Promise.all([teardown, leader, anchor])
    expect(pool.installed).toHaveLength(2)
    expect(pendingSetups.size).toBe(0)
  })
})
