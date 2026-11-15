import type { AuthorizationIncarnation } from '../../../../shared/authorization-incarnation'
import type { DeviceRegistry } from '../server/pairing/device-registry'
import { DeviceRegistryUnavailableError } from '../server/pairing/device-registry-unavailable'
import type { DeviceSightingFraming } from '../server/pairing/device-sighting'
import type { NetworkSourceClass } from '../transports/websocket/source-admission/network-source-class'
import type { E2EEAuthenticatedDevice } from '../server/mobile-e2ee-authenticated-device'
import type {
  authenticateMobileE2EE,
  MobileE2EEAuthFailureCode
} from './e2ee/mobile-e2ee-auth-validation'

export function preparePairedDeviceReadiness(
  registry: DeviceRegistry,
  initial: E2EEAuthenticatedDevice,
  revalidate: () => ReturnType<typeof authenticateMobileE2EE<E2EEAuthenticatedDevice>>,
  sighting: { sourceClass?: NetworkSourceClass; framing: DeviceSightingFraming }
):
  | { ok: true; device: E2EEAuthenticatedDevice & { authority: AuthorizationIncarnation } }
  | { ok: false; code: MobileE2EEAuthFailureCode } {
  let device = initial
  try {
    if (!registry.validateReadyAuthority(device, device.authority)) {
      const checked = revalidate()
      if (!checked.ok) {
        return checked
      }
      device = checked.device
      if (!registry.validateReadyAuthority(device, device.authority)) {
        return { ok: false, code: 'unauthorized' }
      }
    }
    registry.updateLastSeenDeferred(device.deviceId, sighting.sourceClass, sighting.framing)
    if (device.deviceToken === undefined) {
      registry.retireForkedTicket(device.deviceId, {
        principal: device,
        authority: device.authority
      })
    }
    // Readiness may publish a competing row or retire a parent ticket: prove the actual credential again.
    const checked = revalidate()
    if (!checked.ok) {
      return checked
    }
    device = checked.device
    const authority = registry.captureAuthority(device)
    if (!authority) {
      return { ok: false, code: 'unauthorized' }
    }
    return { ok: true, device: { ...device, authority } }
  } catch (error) {
    if (error instanceof DeviceRegistryUnavailableError) {
      if (error.reason === 'conflict') {
        const checked = revalidate()
        if (!checked.ok) {
          return checked
        }
      }
      return { ok: false, code: 'registry_unavailable' }
    }
    if (error instanceof Error && error.message === 'unauthorized') {
      return { ok: false, code: 'unauthorized' }
    }
    console.error('[mobile] Failed to prepare device authentication:', error)
    return { ok: false, code: 'registry_unavailable' }
  }
}
