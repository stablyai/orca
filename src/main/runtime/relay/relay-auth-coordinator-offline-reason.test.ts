import { describe, expect, it, vi } from 'vitest'
import { RELAY_HOST_CLOSE_REASON } from '../../../shared/relay-host-close-reason'
import { RelayAuthCoordinator, type RelayAuthContext } from './relay-auth-coordinator'

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
  it('starts with no offline reason before any reconcile', () => {
    const { coordinator } = coordinatorOver(async () => context)
    expect(coordinator.getOfflineReason()).toBeNull()
  })

  it('records signed_out (the wire close reason) when the cloud session is gone', async () => {
    let current: RelayAuthContext | null = null
    const { coordinator } = coordinatorOver(async () => current)
    coordinator.reconcile()
    await coordinator.waitForLiveBroker()

    expect(coordinator.getOfflineReason()).toBe(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
  })

  it('records not_entitled when the session survives but relay.use is missing', async () => {
    const { coordinator } = coordinatorOver(async () => ({ ...context, relayEntitled: false }))
    coordinator.reconcile()
    await coordinator.waitForLiveBroker()

    expect(coordinator.getOfflineReason()).toBe('not_entitled')
  })

  it('records broker_unavailable when openBroker rejects', async () => {
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker: async () => {
        throw new Error('transport failure')
      },
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await coordinator.waitForLiveBroker()

    expect(coordinator.getOfflineReason()).toBe('broker_unavailable')
  })

  it('clears the offline reason once a broker is registered again', async () => {
    let current: RelayAuthContext | null = null
    const { broker, coordinator } = coordinatorOver(async () => current)
    coordinator.reconcile()
    await coordinator.waitForLiveBroker()
    expect(coordinator.getOfflineReason()).toBe(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)

    current = context
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    expect(coordinator.getOfflineReason()).toBeNull()
  })
})
