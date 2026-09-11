import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobilePairingConnectionContext } from '../runtime-rpc'
import { DesktopRelayService, pairingAuthorizationForContext } from './desktop-relay-service'

const relayHostId = 'AbCdEf0123_-xyZ9'

function context(
  transport: MobilePairingConnectionContext['transport']
): MobilePairingConnectionContext {
  return { deviceId: 'device-1', connectionId: 'e2ee-connection-1', transport }
}

describe('pairingAuthorizationForContext', () => {
  it('derives direct authorization only from the authenticated connection', () => {
    expect(pairingAuthorizationForContext(context({ transport: 'direct' }), relayHostId)).toEqual({
      mode: 'authenticated-direct',
      directAuthId: 'e2ee-connection-1'
    })
  })

  it('derives invite authorization only from immutable relay metadata', () => {
    expect(
      pairingAuthorizationForContext(
        context({
          transport: 'relay',
          relayHostId,
          relayDeviceId: 'device-1',
          basisConnId: 'relay-basis-1',
          credentialKind: 'invite'
        }),
        relayHostId
      )
    ).toEqual({ mode: 'relay-basis', basisConnId: 'relay-basis-1' })
  })

  it('reserves resume metadata for confirmation and rejects stale hosts', () => {
    expect(
      pairingAuthorizationForContext(
        context({
          transport: 'relay',
          relayHostId,
          relayDeviceId: 'device-1',
          basisConnId: 'resume-basis-1',
          credentialKind: 'resume'
        }),
        relayHostId
      )
    ).toBeNull()
    expect(() =>
      pairingAuthorizationForContext(
        context({
          transport: 'relay',
          relayHostId: 'stale-host-id-1',
          relayDeviceId: 'device-1',
          basisConnId: 'relay-basis-1',
          credentialKind: 'invite'
        }),
        relayHostId
      )
    ).toThrow('stale_relay_connection')
  })
})

describe('liveness safety net lifecycle', () => {
  afterEach(() => vi.useRealTimers())

  it('fences hard: the tick stops on fence and re-arms on the next auth mutation', () => {
    // Why: a tick surviving the pre-sign-out fence could catch the window
    // before the profile wipe and briefly resurrect a broker.
    vi.useFakeTimers()
    const coordinator = {
      reconcile: vi.fn(),
      ensureLive: vi.fn(),
      fenceAndCloseNow: vi.fn(),
      stop: vi.fn()
    }
    const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
    Object.assign(service, {
      coordinator,
      demandLedger: { nextPendingExpiry: () => null },
      stopped: false,
      livenessTimer: null,
      demandExpiryTimer: null
    })

    service.start()
    vi.advanceTimersByTime(5 * 60_000)
    expect(coordinator.ensureLive).toHaveBeenCalledTimes(1)

    service.fenceAndCloseNow()
    expect(coordinator.fenceAndCloseNow).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(30 * 60_000)
    expect(coordinator.ensureLive).toHaveBeenCalledTimes(1)

    service.authMutated()
    vi.advanceTimersByTime(5 * 60_000)
    expect(coordinator.ensureLive).toHaveBeenCalledTimes(2)

    service.stop()
    vi.advanceTimersByTime(30 * 60_000)
    expect(coordinator.ensureLive).toHaveBeenCalledTimes(2)
  })
})

describe('host LAN policy applies to already-paired devices (#18211)', () => {
  function serviceUnderPolicy(
    hostMode: () => 'automatic' | 'local-only',
    deviceMode: 'automatic' | 'local-only' = 'automatic'
  ) {
    const registry = {
      getDevice: () => ({ deviceId: 'device-1', scope: 'mobile' }),
      getMobilePairingConnectionMode: () => deviceMode
    }
    const coordinator = { reconcile: vi.fn(), stop: vi.fn() }
    const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
    Object.assign(service, {
      coordinator,
      demandLedger: { nextPendingExpiry: () => null, acquireTransient: () => () => {} },
      hostMobilePairingConnectionMode: hostMode,
      stopped: false,
      livenessTimer: null,
      demandExpiryTimer: null
    })
    Object.defineProperty(service, 'runtimeRpc', {
      value: { getDeviceRegistry: () => registry }
    })
    return { service, coordinator }
  }

  afterEach(() => vi.useRealTimers())

  it('refuses every relay grant for an automatic device once the host picks LAN', async () => {
    vi.useFakeTimers()
    const { service } = serviceUnderPolicy(() => 'local-only')
    await expect(service.getEndpoints(context({ transport: 'direct' }), {})).resolves.toEqual({
      v: 1,
      relay: null
    })
    await expect(
      service.provisionRelay(context({ transport: 'direct' }), {
        reqId: 'install-1',
        newResumeTokenHash: 'A'.repeat(43)
      })
    ).rejects.toThrow('relay_disabled_for_device')
    // Why: createPairingRelay had no per-device gate at all; the choke point
    // in withTransientDemand is what covers it.
    await expect(service.createPairingRelay('device-1')).rejects.toThrow(
      'relay_disabled_for_device'
    )
    service.stop()
  })

  it('never grants Relay to a local-only device even when the host allows it', async () => {
    vi.useFakeTimers()
    const { service } = serviceUnderPolicy(() => 'automatic', 'local-only')
    await expect(service.createPairingRelay('device-1')).rejects.toThrow(
      'relay_disabled_for_device'
    )
    service.stop()
  })

  it('pairingPolicyChanged reconciles without the pairing-churn linger', () => {
    vi.useFakeTimers()
    const { service, coordinator } = serviceUnderPolicy(() => 'local-only')
    service.pairingPolicyChanged()
    expect(coordinator.reconcile).toHaveBeenLastCalledWith({ skipLinger: true })
    service.demandStateChanged()
    expect(coordinator.reconcile).toHaveBeenLastCalledWith(undefined)
    service.stop()
  })
})

describe('local-only mobile pairing', () => {
  it('refuses endpoint discovery and provisioning without opening Relay demand', async () => {
    const registry = {
      getDevice: () => ({ deviceId: 'device-1', scope: 'mobile' }),
      getMobilePairingConnectionMode: () => 'local-only'
    }
    const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
    Object.defineProperty(service, 'runtimeRpc', {
      value: { getDeviceRegistry: () => registry }
    })

    await expect(service.getEndpoints(context({ transport: 'direct' }), {})).resolves.toEqual({
      v: 1,
      relay: null
    })
    await expect(
      service.provisionRelay(context({ transport: 'direct' }), {
        reqId: 'install-1',
        newResumeTokenHash: 'A'.repeat(43)
      })
    ).rejects.toThrow('relay_disabled_for_device')
  })
})

describe('fence clears the pending demand-expiry timeout', () => {
  afterEach(() => vi.useRealTimers())

  // The lifecycle test above stubs `nextPendingExpiry` to null, so it never arms the second timer
  // this class owns. With a pairing invite outstanding the fence left that timeout armed, and
  // `stop()` — the only method that cleared it — has no production caller. The orphaned timeout
  // then ran `refreshDemand`, which reconciles AND re-installs the liveness interval the fence had
  // just torn down: the post-fence resurrection the fence comment forbids.
  it('leaves no armed timer and cannot reconcile after a fence', () => {
    vi.useFakeTimers()
    const coordinator = {
      reconcile: vi.fn(),
      ensureLive: vi.fn(),
      fenceAndCloseNow: vi.fn(),
      stop: vi.fn()
    }
    const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
    Object.assign(service, {
      coordinator,
      // A pending invite: the QR is minted and its server-side expiry is still in the future.
      demandLedger: { nextPendingExpiry: () => Date.now() + 30_000 },
      stopped: false,
      livenessTimer: null,
      demandExpiryTimer: null
    })

    service.start()
    expect(coordinator.reconcile).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(2)

    service.fenceAndCloseNow()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(30 * 60_000)
    expect(coordinator.reconcile).toHaveBeenCalledTimes(1)
    expect(coordinator.ensureLive).not.toHaveBeenCalled()

    // A fence is not a stop: the next auth mutation still re-arms both timers.
    service.authMutated()
    expect(coordinator.reconcile).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(2)
    service.stop()
  })
})
