import { afterEach, describe, expect, it, vi } from 'vitest'
import { mobileRelayMintFailureFromUnknown } from '../../../shared/mobile-relay-mint-failure'
import { DesktopRelayService } from './desktop-relay-service'
import { RelayAuthCoordinator } from './relay-auth-coordinator'
import type { RelayAuthContext } from './relay-auth-identity'
import { RelayHttpError } from './relay-http-client'
import { relayRetryFloorMs, relayUnavailableReasonFor } from './relay-readiness'
import { RelaySessionBroker } from './relay-session-broker'

const context: RelayAuthContext = {
  identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
  accessToken: 'access-1',
  relayEntitled: true
}

function fakeSessionBroker(): RelaySessionBroker {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service only calls the stubbed members below.
  const broker = Object.create(RelaySessionBroker.prototype) as RelaySessionBroker
  Object.defineProperties(broker, {
    closeNow: { value: vi.fn() },
    isLive: { value: () => true },
    createPairingRelay: { value: vi.fn(async () => ({ inviteExpiresAt: 1 })) },
    endpoint: { value: null },
    hostId: { value: 'host-1' },
    ownerIdentityKey: { value: 'owner-1' }
  })
  return broker
}

function serviceWith(coordinator: RelayAuthCoordinator): DesktopRelayService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createPairingRelay touches only the fields assigned here.
  const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
  return Object.assign(service, {
    coordinator,
    stopped: false,
    livenessTimer: null,
    demandExpiryTimer: null,
    demandLedger: { acquireTransient: () => () => {}, nextPendingExpiry: () => null }
  })
}

async function mintFailureCode(service: DesktopRelayService): Promise<string> {
  const error = await service.createPairingRelay('device-1').then(
    () => null,
    (caught: unknown) => caught
  )
  return mobileRelayMintFailureFromUnknown({
    stage: 'create_pairing_relay',
    error,
    fallbackCode: 'relay_mint_failed',
    fallbackMessage: 'failed'
  }).code
}

describe('relay readiness', () => {
  afterEach(() => vi.useRealTimers())

  it('waits through the retry a cold-start failure scheduled instead of failing the mint', async () => {
    vi.useFakeTimers()
    const broker = fakeSessionBroker()
    const openBroker = vi
      .fn()
      .mockRejectedValueOnce(new RelayHttpError('assignment', 503))
      .mockResolvedValueOnce(broker)
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: () => {},
      random: () => 1
    })
    const service = serviceWith(coordinator)
    const mint = service.createPairingRelay('device-1')
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(mint).resolves.toMatchObject({ binding: { relayHostId: 'host-1' } })
    expect(openBroker).toHaveBeenCalledTimes(2)
    service.stop()
  })

  it('reports the failure cause when the retry falls outside the wait', async () => {
    vi.useFakeTimers()
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker: async () => {
        throw new RelayHttpError('assignment', 503, 60_000)
      },
      onStatus: () => {}
    })
    const service = serviceWith(coordinator)
    await expect(mintFailureCode(service)).resolves.toBe('relay_director_assignment_503')
    service.stop()
  })

  it('names a signed-out or unentitled desktop instead of relay_control_not_active', async () => {
    let current: RelayAuthContext | null = null
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      openBroker: async () => fakeSessionBroker(),
      onStatus: () => {}
    })
    const service = serviceWith(coordinator)
    await expect(mintFailureCode(service)).resolves.toBe('relay_signed_out')
    current = { ...context, relayEntitled: false }
    await expect(mintFailureCode(service)).resolves.toBe('relay_not_entitled')
    service.stop()
  })

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

  it.each(['fence', 'stop'] as const)(
    'a %s releases a waiter whose followed retry is still opening',
    async (action) => {
      vi.useFakeTimers()
      const coordinator = coldStartWithHungRetry()
      coordinator.reconcile()
      let settled: unknown = null
      void coordinator.waitForReadiness(20_000).then((readiness) => (settled = readiness))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(settled).toBeNull()
      if (action === 'fence') {
        coordinator.fenceAndCloseNow()
      } else {
        coordinator.stop()
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toMatchObject({ ready: false, retryAt: null })
      coordinator.stop()
    }
  )

  it('floors a limit-coded or repeated rate limit, but keeps a lone 4429 fast (#21203)', () => {
    const limitCoded = new Error('relay_control_error_limit_exceeded')
    const closed4429 = new Error('relay_control_closed_4429')
    expect(relayUnavailableReasonFor(limitCoded)).toBe('control_error_limit_exceeded')
    expect(relayRetryFloorMs(limitCoded, 0)).toBe(5_000)
    expect(relayRetryFloorMs(closed4429, 0)).toBe(0)
    expect(relayRetryFloorMs(closed4429, 1)).toBe(5_000)
    expect(relayRetryFloorMs(closed4429, 2)).toBe(10_000)
    expect(relayRetryFloorMs(closed4429, 9)).toBe(30_000)
    expect(relayRetryFloorMs(new Error('relay_control_error_unknown_control_message'), 3)).toBe(0)
    expect(relayRetryFloorMs(new RelayHttpError('assignment', 503, 7_000), 0)).toBe(7_000)
  })

  it('paces a coordinator whose control keeps closing 4429', async () => {
    vi.useFakeTimers()
    const openBroker = vi.fn(async () => {
      throw new Error('relay_control_closed_4429')
    })
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: () => {},
      random: () => 0
    })
    coordinator.reconcile()
    // A lone 4429 retries at once (zero jitter); the repeat then waits 5 s.
    await vi.advanceTimersByTimeAsync(0)
    expect(openBroker).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(openBroker).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(openBroker).toHaveBeenCalledTimes(3)
    coordinator.stop()
  })

  it('classifies transport failures into actionable reasons', () => {
    const tls = new TypeError('fetch failed', {
      cause: Object.assign(new Error('unable to get local issuer certificate'), {
        code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
      })
    })
    expect(relayUnavailableReasonFor(tls)).toBe('tls_untrusted')
    expect(relayUnavailableReasonFor(new RelayHttpError('assignment', 429))).toBe('rate_limited')
    expect(relayUnavailableReasonFor(new Error('relay_control_closed_4429'))).toBe('rate_limited')
    expect(relayUnavailableReasonFor(new Error('relay_control_connect_timeout'))).toBe(
      'control_connect_timeout'
    )
    expect(relayUnavailableReasonFor(new Error('ECONNRESET with secret=abc'))).toBe('network')
  })
})
