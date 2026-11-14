import type { DeviceEntry } from './pairing/device-entry'
import { devicePrincipalOf, type DevicePrincipal } from './pairing/device-principal'
import type { AuthorizationIncarnation } from '../../../../shared/authorization-incarnation'

export type E2EEAuthenticatedDevice = DevicePrincipal & {
  // Absent for a keyed row, which never presented a bearer.
  deviceToken?: string
  authority?: AuthorizationIncarnation
}

export function toAuthenticatedDevice(device: DeviceEntry): E2EEAuthenticatedDevice {
  return {
    ...devicePrincipalOf(device),
    ...(device.token !== undefined ? { deviceToken: device.token } : {})
  }
}
