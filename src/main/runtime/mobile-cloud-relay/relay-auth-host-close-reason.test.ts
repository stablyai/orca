import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELAY_HOST_CLOSE_REASON } from '../../../shared/relay-host-close-reason'
import { RelayAuthCoordinator } from './relay-auth-coordinator'
import type { RelayAuthContext } from './relay-auth-identity'

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

describe('relay control close reason', () => {
  afterEach(() => vi.useRealTimers())
  it('names the sign-out when the cloud session is gone', async () => {
    let current: RelayAuthContext | null = context
    const { broker, coordinator } = coordinatorOver(async () => current)
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    current = null
    coordinator.reconcile()
    await coordinator.waitForLiveBroker()

    expect(broker.closeNow).toHaveBeenCalledWith(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
  })

  it('names the sign-out on the explicit pre-sign-out fence', async () => {
    const { broker, coordinator } = coordinatorOver(async () => context)
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    coordinator.fenceAndCloseNow(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)

    expect(broker.closeNow).toHaveBeenCalledWith(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
  })

  it('stays silent on quit, which fences without a reason', async () => {
    const { broker, coordinator } = coordinatorOver(async () => context)
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    coordinator.fenceAndCloseNow()

    expect(broker.closeNow).toHaveBeenCalledWith(undefined)
  })

  it('stays silent on stop, which is teardown rather than auth loss', async () => {
    const { broker, coordinator } = coordinatorOver(async () => context)
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    coordinator.stop()

    expect(broker.closeNow).toHaveBeenCalledWith(undefined)
  })

  it('stays silent when the session survives but the entitlement is gone', async () => {
    let current: RelayAuthContext = context
    const { broker, coordinator } = coordinatorOver(async () => current)
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    current = { ...context, relayEntitled: false }
    coordinator.reconcile()
    await coordinator.waitForLiveBroker()

    expect(broker.closeNow).toHaveBeenCalledWith(undefined)
  })

  it('stays silent when demand drops and the broker lingers out', async () => {
    vi.useFakeTimers()
    let demanded = true
    const broker = { closeNow: vi.fn() }
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      hasDemand: () => demanded,
      openBroker: async () => broker,
      onStatus: vi.fn(),
      lingerMs: 5
    })
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    demanded = false
    coordinator.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4)
    expect(broker.closeNow).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(broker.closeNow).toHaveBeenCalledOnce()
    expect(broker.closeNow).toHaveBeenCalledWith(undefined)
    coordinator.stop()
  })

  it('stays silent when an identity switch replaces the broker', async () => {
    let current = context
    const brokers: { closeNow: ReturnType<typeof vi.fn> }[] = []
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      openBroker: async () => {
        const broker = { closeNow: vi.fn() }
        brokers.push(broker)
        return broker
      },
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await coordinator.waitForLiveBroker()

    current = { ...context, identity: { ...context.identity, organizationId: 'org-2' } }
    coordinator.reconcile()
    await coordinator.waitForLiveBroker()

    expect(brokers[0]?.closeNow).toHaveBeenCalledWith(undefined)
  })
})
