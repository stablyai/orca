import { afterEach, describe, expect, it, vi } from 'vitest'

import '../desktop-relay-service'
import { RelayAuthCoordinator } from './relay-auth-coordinator'
import type { RelayAuthContext } from './relay-auth-identity'
import { RelayHttpError } from '../director/relay-http-client'

import '../session-lifecycle/relay-session-broker'

const context: RelayAuthContext = {
  identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
  accessToken: 'access-1',
  relayEntitled: true
}

describe('relay readiness', () => {
  afterEach(() => vi.useRealTimers())

  it('stops waiting when a fence cancels the scheduled retry', async () => {
    vi.useFakeTimers()
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker: async () => {
        throw new RelayHttpError('token-exchange', 502)
      },
      onStatus: () => {},
      random: () => 1
    })
    coordinator.reconcile()
    const waiting = coordinator.waitForReadiness(20_000)
    await vi.advanceTimersByTimeAsync(0)
    coordinator.fenceAndCloseNow()
    await expect(waiting).resolves.toEqual({
      ready: false,
      reason: 'control_not_active',
      retryAt: null
    })
  })

  function coldStartWithHungRetry(): RelayAuthCoordinator {
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 503))
      .mockImplementationOnce(() => new Promise(() => {}))
    return new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: () => {},
      random: () => 0.5
    })
  }

  it('returns at its deadline while the retry it followed is still opening', async () => {
    vi.useFakeTimers()
    const coordinator = coldStartWithHungRetry()
    coordinator.reconcile()
    let settled: unknown = null
    void coordinator.waitForReadiness(10_000).then((readiness) => (settled = readiness))
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toMatchObject({ ready: false, reason: 'director_assignment_503' })
    coordinator.stop()
  })
})
