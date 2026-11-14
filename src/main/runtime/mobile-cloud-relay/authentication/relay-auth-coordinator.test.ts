import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAuthCoordinator } from './relay-auth-coordinator'
import type { RelayAuthContext } from './relay-auth-identity'
import type { RelayAccessTokenRefresh } from '../session-lifecycle/relay-session-broker-contract'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const context: RelayAuthContext = {
  identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
  accessToken: 'access-1',
  relayEntitled: true
}

describe('RelayAuthCoordinator', () => {
  afterEach(() => vi.useRealTimers())

  it('rejects a token refresh whose session read crosses an auth mutation', async () => {
    const refreshRead = deferred<RelayAuthContext | null>()
    let readCount = 0
    let current = context
    let refreshAccessToken: (() => Promise<RelayAccessTokenRefresh>) | null = null
    const coordinator = new RelayAuthCoordinator({
      readContext: () => {
        readCount += 1
        return readCount === 2 ? refreshRead.promise : Promise.resolve(current)
      },
      openBroker: async (input) => {
        refreshAccessToken = input.refreshAccessToken
        return { closeNow: vi.fn() }
      },
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await vi.waitFor(() => expect(refreshAccessToken).not.toBeNull())
    const refreshing = refreshAccessToken!()
    current = { ...context, identity: { ...context.identity, organizationId: 'org-2' } }
    coordinator.reconcile()
    refreshRead.resolve(context)

    await expect(refreshing).resolves.toEqual({ accessToken: null })
    await vi.waitFor(() => expect(readCount).toBeGreaterThanOrEqual(3))
  })

  it('rebuilds a self-closed broker on the next ensureLive and leaves a replaced one alone', async () => {
    vi.useFakeTimers()
    let live = true
    const openBroker = vi.fn(async () => {
      live = true
      return { closeNow: vi.fn(), isLive: () => live }
    })
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    // A stale broker's self-close reaches ensureLive while the current one is live: no rebuild.
    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(1)

    // Token refresh gave up: the broker is closed, neither live nor recovering.
    live = false
    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
    coordinator.stop()
  })

  it('keeps a dead broker whose pool is already re-asking the director', async () => {
    vi.useFakeTimers()
    let recovering = true
    const closeNow = vi.fn()
    const openBroker = vi.fn(async () => ({
      closeNow,
      isLive: () => false,
      isRecovering: () => recovering
    }))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)

    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(1)
    expect(closeNow).not.toHaveBeenCalled()

    // Once the pool stops retrying (or its relay JWT runs out), the tick rebuilds as before.
    recovering = false
    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeNow).toHaveBeenCalledTimes(1)
    expect(openBroker).toHaveBeenCalledTimes(2)
    coordinator.stop()
  })
})
