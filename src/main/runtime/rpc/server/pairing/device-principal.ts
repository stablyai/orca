import type { DeviceEntry } from './device-entry'
import type { RpcCallerScope } from '../../callers/rpc-caller-scope'
import { createHash } from 'node:crypto'

/** Socket revoke/close uses deviceId; per-client drivers, dictation and file grants use clientId. */
export type DevicePrincipal = {
  deviceId: string
  scope: DeviceEntry['scope']
  // Shipped phones use bearer tokens in terminal client.id; keyed rows use device ids.
  clientId: string
  callerFingerprint: string
  credentialRevision: number
}

export function devicePrincipalOf(device: DeviceEntry): DevicePrincipal {
  return {
    deviceId: device.deviceId,
    scope: device.scope,
    clientId: device.token ?? device.deviceId,
    callerFingerprint:
      device.callerFingerprint ??
      fingerprintAuthenticatedPairingCredential(device.token ?? `device:${device.deviceId}`),
    credentialRevision: device.credentialRevision ?? 0
  }
}

export function callerScopeOf(device: DeviceEntry): RpcCallerScope {
  return device.scope === 'mobile'
    ? { kind: 'mobile', delegated: device.parentDeviceId !== undefined }
    : { kind: 'runtime-paired', grants: device.grants ?? [] }
}

export function fingerprintAuthenticatedPairingCredential(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The credential fingerprint a paired device holds now, by device id: null once it was removed,
 *  undefined while no registry is loaded to tell. */
export function pairedDeviceCredentials(
  registry: () => { getDevice: (deviceId: string) => DeviceEntry | null } | null
): (deviceId: string) => string | null | undefined {
  return (deviceId) => {
    const current = registry()
    if (!current) {
      return undefined
    }
    const device = current.getDevice(deviceId)
    return device ? devicePrincipalOf(device).callerFingerprint : null
  }
}
