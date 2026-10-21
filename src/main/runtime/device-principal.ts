import type { DeviceEntry } from './device-registry'
import type { RpcCallerScope } from './rpc/rpc-caller-scope'
import { createHash } from 'node:crypto'

/**
 * Who an authenticated paired socket is. Socket bookkeeping (close, revoke) keys on `deviceId`;
 * per-client runtime state (terminal drivers, dictation, file grants) keys on `clientId`.
 */
export type DevicePrincipal = {
  deviceId: string
  scope: DeviceEntry['scope']
  // Why: token rows keep their token here because shipped phones stamp it into terminal
  // `client.id` params; a row without a token is keyed by its id.
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
