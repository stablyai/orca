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
