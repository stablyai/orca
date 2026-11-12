import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAuthCoordinator } from './relay-auth-coordinator'
import type { RelayAuthContext } from './relay-auth-identity'
import { RelayHttpError } from './relay-http-client'

const context: RelayAuthContext = {
  identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
  accessToken: 'access-1',
  relayEntitled: true
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RelayAuthCoordinator transient recovery', () => {
  it('does not carry a pending retry across an identity switch', async () => {
    vi.useFakeTimers()
    let current = context
    const broker = { closeNow: vi.fn() }
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary control open failure'))
      .mockResolvedValueOnce(broker)
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.75
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    current = {
      ...context,
      identity: { ...context.identity, profileId: 'profile-2' }
    }
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
    expect(coordinator.getActiveBroker()).toBe(broker)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledTimes(2)
  })
})

describe('RelayAuthCoordinator liveness safety net', () => {
  it('reopens a broker that died leaving no retry timer behind', async () => {
    // Expired-token refresh failure leaves no retry; ensureLive must revive it.
    vi.useFakeTimers()
    const dead = { closeNow: vi.fn(), isLive: () => false }
    const live = { closeNow: vi.fn(), isLive: () => true }
    const openBroker = vi.fn().mockResolvedValueOnce(dead).mockResolvedValueOnce(live)
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.getActiveBroker()).toBe(dead)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(openBroker).toHaveBeenCalledOnce()

    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
    expect(dead.closeNow).toHaveBeenCalled()
    expect(coordinator.getActiveBroker()).toBe(live)
  })

  it('does not disturb a live broker, a scheduled retry, or an open in flight', async () => {
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn(), isLive: () => true }
    let releaseOpen: ((value: typeof broker) => void) | undefined
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 503, 30_000))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOpen = resolve
          })
      )
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(openBroker).toHaveBeenCalledTimes(2)
    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
    releaseOpen?.(broker)
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.getActiveBroker()).toBe(broker)

    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
  })
})
