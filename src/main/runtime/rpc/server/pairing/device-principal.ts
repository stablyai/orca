import type { DeviceEntry } from './device-entry'
import type { BotShareCallerScope, RpcCallerScope } from '../../callers/rpc-caller-scope'
import type { BotShareDevice, BotShareGrant } from './bot-share-device-store'
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

/** A share device signs in by key alone, so it is its own client and federation owner. */
export function botSharePrincipalOf(
  device: BotShareDevice
): DevicePrincipal & { botShare: BotShareGrant } {
  return {
    deviceId: device.deviceId,
    scope: device.scope,
    clientId: device.deviceId,
    callerFingerprint: fingerprintAuthenticatedPairingCredential(`bot-share:${device.deviceId}`),
    credentialRevision: 0,
    botShare: { botId: device.botId, accountId: device.accountId, name: device.name }
  }
}

export function botShareCallerScopeOf(device: BotShareDevice): BotShareCallerScope {
  return { kind: 'bot-share', botId: device.botId, accountId: device.accountId, name: device.name }
}

export function fingerprintAuthenticatedPairingCredential(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
