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

function coordinatorWith(options: {
  openBroker: () => Promise<{ closeNow(): void; isLive?(): boolean }>
  readContext?: () => Promise<RelayAuthContext | null>
}) {
  const statuses: string[] = []
  const coordinator = new RelayAuthCoordinator({
    readContext: options.readContext ?? (async () => context),
    openBroker: options.openBroker,
    onStatus: (status) => statuses.push(status),
    random: () => 0.5
  })
  return { coordinator, statuses }
}

describe('RelayAuthCoordinator reconnecting status', () => {
  it('keeps every retry attempt reconnecting until it registers', async () => {
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 503))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(broker)
    const { coordinator, statuses } = coordinatorWith({ openBroker })

    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(openBroker).toHaveBeenCalledTimes(3)
    expect(statuses[0]).toBe('connecting')
    expect(statuses.at(-1)).toBe('registered')
    expect(statuses.slice(1, -1)).toEqual(Array(4).fill('reconnecting'))
  })

  it('publishes terminal offline for a non-retryable failure', async () => {
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('assignment', 403))
    const { coordinator, statuses } = coordinatorWith({ openBroker })

    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker(15_000)).resolves.toBeNull()

    expect(statuses).toEqual(['connecting', 'offline'])
  })

  it('publishes offline when signed out, even mid-recovery', async () => {
    vi.useFakeTimers()
    let current: RelayAuthContext | null = context
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('assignment', 503))
    const { coordinator, statuses } = coordinatorWith({
      openBroker,
      readContext: async () => current
    })
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses.at(-1)).toBe('reconnecting')

    current = null
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses.at(-1)).toBe('offline')

    current = context
    openBroker.mockResolvedValueOnce({ closeNow: vi.fn() })
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    // A fresh sign-in starts a first connect, not a reconnect.
    expect(statuses.slice(-2)).toEqual(['connecting', 'registered'])
  })
})

describe('RelayAuthCoordinator.waitForLiveBroker grace', () => {
  it('rides out a stall shorter than the grace', async () => {
    vi.useFakeTimers()
    const broker = { closeNow: vi.fn() }
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 503))
      .mockRejectedValueOnce(new RelayHttpError('assignment', 503))
      .mockResolvedValueOnce(broker)
    const { coordinator } = coordinatorWith({ openBroker })

    coordinator.reconcile()
    const waited = coordinator.waitForLiveBroker(15_000)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(waited).resolves.toBe(broker)
  })

  it('gives up at the grace deadline while retries continue', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('assignment', 503, 30_000))
    const { coordinator, statuses } = coordinatorWith({ openBroker })

    coordinator.reconcile()
    const waited = coordinator.waitForLiveBroker(15_000)
    let settled = false
    void waited.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(waited).resolves.toBeNull()
    expect(statuses.at(-1)).toBe('reconnecting')
  })

  it('returns at once without grace, as before', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('assignment', 503))
    const { coordinator } = coordinatorWith({ openBroker })

    coordinator.reconcile()
    const waited = coordinator.waitForLiveBroker()
    await vi.advanceTimersByTimeAsync(0)

    await expect(waited).resolves.toBeNull()
    expect(openBroker).toHaveBeenCalledOnce()
  })

  it('fails fast when a fence lands during the wait', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('assignment', 503))
    const { coordinator, statuses } = coordinatorWith({ openBroker })

    coordinator.reconcile()
    const waited = coordinator.waitForLiveBroker(15_000)
    await vi.advanceTimersByTimeAsync(0)
    coordinator.fenceAndCloseNow()
    await vi.advanceTimersByTimeAsync(0)

    await expect(waited).resolves.toBeNull()
    expect(statuses.at(-1)).toBe('offline')
  })
})
