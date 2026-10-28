import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_PHYSICAL_WATCHER_CHILDREN,
  reserveWatcherChild,
  resetWatcherChildRegistryForTest
} from './parcel-watcher-child-registry'
import { WatcherSupervisorCapacityWait } from './parcel-watcher-supervisor-capacity-wait'

describe('WatcherSupervisorCapacityWait', () => {
  beforeEach(() => resetWatcherChildRegistryForTest())
  afterEach(() => resetWatcherChildRegistryForTest())

  it('removes ten thousand cancelled capacity callers while one anchor remains', async () => {
    const releases = Array.from({ length: MAX_PHYSICAL_WATCHER_CHILDREN }, () =>
      reserveWatcherChild()
    )
    expect(releases.every(Boolean)).toBe(true)
    const capacity = new WatcherSupervisorCapacityWait()
    const anchor = capacity.wait()
    const controllers = Array.from({ length: 10_000 }, () => new AbortController())
    const cancelled = controllers.map((controller) =>
      capacity.wait(controller.signal).catch((error) => error)
    )

    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(cancelled)

    expect(capacity.waiterCount).toBe(1)
    releases[0]?.()
    await expect(anchor).resolves.toBeUndefined()
    expect(capacity.waiterCount).toBe(0)
  })
})
