import { isTestRelayRuntimeDevice } from '../../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import type { DeviceEntry } from './device-entry'
import type { BotShareCallerScope, RpcCallerScope } from '../../callers/rpc-caller-scope'
import type { BotShareDevice, BotShareGrant } from './bot-share-device-store'
import { createHash } from 'node:crypto'
import { BOTS_SHARE_WORKSPACES_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import { unshippedTestSwitchOn } from '../../../../../shared/app-lifecycle/unshipped-test-switch'

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

// Dev-only rig switch: a paired desktop calls as a teammate with the workspace tier.
const PAIRED_DEVICE_AS_TEAMMATE_TEST_SWITCH = 'ORCA_TEST_PAIRED_DEVICE_AS_TEAMMATE'

export function callerScopeOf(device: DeviceEntry): RpcCallerScope {
  if (device.scope === 'runtime' && unshippedTestSwitchOn(PAIRED_DEVICE_AS_TEAMMATE_TEST_SWITCH)) {
    return {
      kind: 'bot-share',
      botId: '',
      accountId: device.deviceId,
      workspaceTier: true
    }
  }
  return device.scope === 'mobile'
    ? { kind: 'mobile', delegated: device.parentDeviceId !== undefined }
    : {
        kind: 'runtime-paired',
        grants: device.grants ?? [],
        ...(isTestRelayRuntimeDevice(device) ? { relayCredentialSelf: true as const } : {})
      }
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
    botShare: { botId: device.botId, accountId: device.accountId }
  }
}

/** The one place a share device's scope is stamped: who it acts for, and whether its Orca (by the
 *  capabilities its handshake sent) works in the agent's workspaces. */
export function botShareCallerScopeOf(
  device: BotShareDevice,
  clientCapabilities: readonly string[] | undefined
): BotShareCallerScope {
  return {
    kind: 'bot-share',
    botId: device.botId,
    accountId: device.accountId,
    ...(clientCapabilities?.includes(BOTS_SHARE_WORKSPACES_CAPABILITY)
      ? { workspaceTier: true as const }
      : {})
  }
}

export function fingerprintAuthenticatedPairingCredential(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
