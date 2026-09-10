import { describe, expect, it } from 'vitest'
import type { RelayOfflineReason } from './relay-offline-reason'
import { DesktopRelayService } from './desktop-relay-service'

// Why Object.create + Object.assign: mirrors the constructor-bypassing setup
// the existing 'liveness safety net lifecycle' test uses to fake the private
// coordinator field without standing up a real broker/runtimeRpc.
function serviceWithOfflineReason(offlineReason: RelayOfflineReason | null): {
  requireActiveBroker: () => Promise<unknown>
} {
  const coordinator = {
    getActiveBroker: () => null,
    getLiveBroker: () => null,
    waitForLiveBrokerResult: async () => ({ broker: null, offlineReason })
  }
  const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
  Object.assign(service, { coordinator })
  return service as unknown as { requireActiveBroker: () => Promise<unknown> }
}

describe('DesktopRelayService.requireActiveBroker failure cause codes', () => {
  it('names a signed-out session instead of the generic control-not-active code', async () => {
    await expect(serviceWithOfflineReason('signed-out').requireActiveBroker()).rejects.toThrow(
      'relay_signed_out'
    )
  })

  it('names a missing entitlement instead of the generic control-not-active code', async () => {
    await expect(serviceWithOfflineReason('not_entitled').requireActiveBroker()).rejects.toThrow(
      'relay_not_entitled'
    )
  })

  it('names a broker that never came up instead of the generic control-not-active code', async () => {
    await expect(
      serviceWithOfflineReason('broker_unavailable').requireActiveBroker()
    ).rejects.toThrow('relay_broker_unavailable')
  })

  it('names a relay that rejected this desktop instead of the generic control-not-active code', async () => {
    await expect(serviceWithOfflineReason('broker_rejected').requireActiveBroker()).rejects.toThrow(
      'relay_broker_rejected'
    )
  })

  it('names a cloud session that could not be read instead of blaming the relay', async () => {
    await expect(
      serviceWithOfflineReason('auth_unavailable').requireActiveBroker()
    ).rejects.toThrow('relay_auth_unavailable')
  })

  it('falls back to relay_control_not_active when no cause was recorded', async () => {
    await expect(serviceWithOfflineReason(null).requireActiveBroker()).rejects.toThrow(
      'relay_control_not_active'
    )
  })
})
