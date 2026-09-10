import { describe, expect, it, vi } from 'vitest'
import { RELAY_HOST_CLOSE_REASON } from '../../../shared/relay-host-close-reason'
import { RelayAuthCoordinator, type RelayAuthContext } from './relay-auth-coordinator'
import { RelayHttpError } from './relay-http-client'

const context: RelayAuthContext = {
  identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
  accessToken: 'access-1',
  relayEntitled: true
}

function coordinatorOver(readContext: () => Promise<RelayAuthContext | null>) {
  const broker = { closeNow: vi.fn() }
  const coordinator = new RelayAuthCoordinator({
    readContext,
    openBroker: async () => broker,
    onStatus: vi.fn()
  })
  return { broker, coordinator }
}

describe('RelayAuthCoordinator offline reason', () => {
  it('carries no offline reason before any reconcile', async () => {
    const { coordinator } = coordinatorOver(async () => context)
    await expect(coordinator.waitForLiveBrokerResult()).resolves.toEqual({
      broker: null,
      offlineReason: null
    })
  })

  it('carries signed_out (the wire close reason) when the cloud session is gone', async () => {
    let current: RelayAuthContext | null = null
    const { coordinator } = coordinatorOver(async () => current)
    coordinator.reconcile()

    await expect(coordinator.waitForLiveBrokerResult()).resolves.toEqual({
      broker: null,
      offlineReason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    })
  })

  it('carries not_entitled when the session survives but relay.use is missing', async () => {
    const { coordinator } = coordinatorOver(async () => ({ ...context, relayEntitled: false }))
    coordinator.reconcile()

    await expect(coordinator.waitForLiveBrokerResult()).resolves.toEqual({
      broker: null,
      offlineReason: 'not_entitled'
    })
  })

  it('carries broker_unavailable when openBroker rejects', async () => {
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker: async () => {
        throw new Error('transport failure')
      },
      onStatus: vi.fn()
    })
    coordinator.reconcile()

    await expect(coordinator.waitForLiveBrokerResult()).resolves.toEqual({
      broker: null,
      offlineReason: 'broker_unavailable'
    })
  })

  it('carries auth_unavailable, not signed_out, when the session read itself fails', async () => {
    // Why: readContext throws on a transport failure or a refresh the session
    // store is deliberately holding back; the session is intact and a retry is
    // armed, so "sign in again" would be the wrong advice and the wrong word.
    vi.useFakeTimers()
    const openBroker = vi.fn()
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => {
        throw new Error('orca_cloud_refresh_replay_blocked')
      },
      openBroker,
      onStatus: vi.fn(),
      random: () => 0.5
    })
    coordinator.reconcile()

    await expect(coordinator.waitForLiveBrokerResult()).resolves.toEqual({
      broker: null,
      offlineReason: 'auth_unavailable'
    })
    expect(openBroker).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('carries the sign-out named on the explicit pre-sign-out fence', async () => {
    const { broker, coordinator } = coordinatorOver(async () => context)
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    coordinator.fenceAndCloseNow(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)

    await expect(coordinator.waitForLiveBrokerResult()).resolves.toEqual({
      broker: null,
      offlineReason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    })
  })

  it('carries broker_rejected, and arms no retry, when the relay answers 4xx', async () => {
    // Why a separate word: a 4xx from token exchange or assignment is not retried
    // (shouldRetryRelayConnectionError), so "unavailable, retrying" would promise
    // a recovery that is not coming.
    vi.useFakeTimers()
    const openBroker = vi.fn().mockRejectedValue(new RelayHttpError('token-exchange', 403))
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn()
    })
    coordinator.reconcile()

    await expect(coordinator.waitForLiveBrokerResult()).resolves.toEqual({
      broker: null,
      offlineReason: 'broker_rejected'
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(openBroker).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('does not let an old reason outlive an unclassified offline', async () => {
    let current: RelayAuthContext | null = null
    const { broker, coordinator } = coordinatorOver(async () => current)
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBrokerResult()).resolves.toMatchObject({
      offlineReason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    })

    current = context
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)
    coordinator.fenceAndCloseNow()

    await expect(coordinator.waitForLiveBrokerResult()).resolves.toEqual({
      broker: null,
      offlineReason: null
    })
  })

  it('does not blame the last sign-out for a broker that merely died later', async () => {
    // Why: a control that dies without a reconcile leaves the last published
    // reason behind; a signed-in user whose relay dropped must not be told to
    // sign in again.
    let current: RelayAuthContext | null = null
    let live = true
    const broker = { closeNow: vi.fn(), isLive: () => live }
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      openBroker: async () => broker,
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBrokerResult()).resolves.toMatchObject({
      offlineReason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    })
    current = context
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    live = false

    await expect(coordinator.waitForLiveBrokerResult()).resolves.toEqual({
      broker: null,
      offlineReason: null
    })
  })

  it('carries the broker, not a stale reason, once one is registered again', async () => {
    let current: RelayAuthContext | null = null
    const { broker, coordinator } = coordinatorOver(async () => current)
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBrokerResult()).resolves.toMatchObject({
      offlineReason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    })

    current = context
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBrokerResult()).resolves.toEqual({ broker })
  })

  it('reports the reason of the reconcile the waiter actually saw, not a later one', async () => {
    // Why: the service maps the reason to a user-facing code after the wait
    // resolves; a reason read separately afterwards could belong to a newer
    // epoch (here: sign-out that happened after the entitlement failure).
    let current: RelayAuthContext | null = { ...context, relayEntitled: false }
    const { coordinator } = coordinatorOver(async () => current)
    coordinator.reconcile()
    const result = await coordinator.waitForLiveBrokerResult()

    current = null
    coordinator.reconcile()
    await coordinator.waitForLiveBroker()

    expect(result).toEqual({ broker: null, offlineReason: 'not_entitled' })
  })
})
