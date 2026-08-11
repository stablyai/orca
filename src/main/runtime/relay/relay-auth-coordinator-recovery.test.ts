import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAuthCoordinator, type RelayAuthContext } from './relay-auth-coordinator'
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
  it('retries a transient assignment failure and activates without an external event', async () => {
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 500))
      .mockResolvedValueOnce(broker)
    const statuses: string[] = []
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: (status) => statuses.push(status),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toBe('offline')

    await vi.advanceTimersByTimeAsync(501)
    expect(openBroker).toHaveBeenCalledTimes(2)
    expect(coordinator.getActiveBroker()).toBe(broker)
    expect(statuses.at(-1)).toBe('registered')
  })

  it('does not retry initial relay setup before the server Retry-After window', async () => {
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 503, 30_000))
      .mockResolvedValueOnce(broker)
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(openBroker).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openBroker).toHaveBeenCalledTimes(2)
    expect(coordinator.getActiveBroker()).toBe(broker)
  })

  it('retries when cloud-session refresh fails before identity can be read', async () => {
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const readContext = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary cloud session refresh failure'))
      .mockResolvedValueOnce(context)
    const openBroker = vi.fn().mockResolvedValue(broker)
    const coordinator = new RelayAuthCoordinator({
      readContext,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(readContext).toHaveBeenCalledOnce()
    expect(openBroker).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(501)
    expect(readContext).toHaveBeenCalledTimes(2)
    expect(openBroker).toHaveBeenCalledOnce()
    expect(coordinator.getActiveBroker()).toBe(broker)
  })

  it('backs a sustained outage off to the five-minute jitter cap', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new Error('temporary control open failure'))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    for (const delayMs of [500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000]) {
      await vi.advanceTimersByTimeAsync(delayMs)
    }
    expect(openBroker).toHaveBeenCalledTimes(10)

    await vi.advanceTimersByTimeAsync(149_999)
    expect(openBroker).toHaveBeenCalledTimes(10)
    await vi.advanceTimersByTimeAsync(1)
    expect(openBroker).toHaveBeenCalledTimes(11)

    await vi.advanceTimersByTimeAsync(150_000)
    expect(openBroker).toHaveBeenCalledTimes(12)
  })

  it('does not retry a permanent authorization response', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('token-exchange', 403))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledOnce()
    expect(coordinator.getActiveBroker()).toBeNull()
  })

  it('cancels a pending retry as soon as demand disappears', async () => {
    vi.useFakeTimers()
    let demanded = true
    const openBroker = vi.fn().mockRejectedValue(new Error('temporary control open failure'))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      hasDemand: () => demanded,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.75
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    demanded = false
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledOnce()
    expect(coordinator.getActiveBroker()).toBeNull()
  })

  it('re-reads demand when the retry fires and stops without opening again', async () => {
    vi.useFakeTimers()
    let demanded = true
    const statuses: string[] = []
    const openBroker = vi.fn().mockRejectedValue(new Error('temporary control open failure'))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      hasDemand: () => demanded,
      openBroker,
      onStatus: (status) => statuses.push(status),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    demanded = false
    await vi.advanceTimersByTimeAsync(501)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toBe('standby')
  })

  it('re-reads entitlement when the retry fires and stops after removal', async () => {
    vi.useFakeTimers()
    let current = context
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('assignment', 500))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    current = { ...context, relayEntitled: false }
    await vi.advanceTimersByTimeAsync(501)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledOnce()
    expect(coordinator.getActiveBroker()).toBeNull()
  })

  it('cancels a pending retry immediately when the coordinator is fenced', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new Error('temporary control open failure'))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    coordinator.fenceAndCloseNow()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(openBroker).toHaveBeenCalledOnce()
    expect(coordinator.getActiveBroker()).toBeNull()
  })

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
    // Why: an auth refresh failing past token expiry closes the broker with
    // no timer; only ensureLive (periodic/power-resume) can revive it.
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

    // A scheduled Retry-After timer owns recovery; ensureLive must not race it.
    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledOnce()

    // The retry fires into a slow open; ensureLive must not preempt it.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openBroker).toHaveBeenCalledTimes(2)
    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
    releaseOpen?.(broker)
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.getActiveBroker()).toBe(broker)

    // A live broker needs nothing.
    coordinator.ensureLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
  })
})
