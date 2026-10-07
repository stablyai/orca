import type { RuntimeAccessGrant } from '../../shared/runtime-access-grants'
import type { DeviceEntry } from './device-registry'

export function toRuntimeAccessGrant(device: DeviceEntry): RuntimeAccessGrant {
  return {
    deviceId: device.deviceId,
    name: device.name,
    createdAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt > 0 ? device.lastSeenAt : null
  }
}
