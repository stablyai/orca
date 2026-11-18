import type { DeviceScope } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RelayDeviceBinding } from '../../../mobile-cloud-relay/pairing/relay-revoke-outbox'
import type { DeviceEntry, DeviceOrcaAccount } from './device-entry'
import { hashDeviceToken } from './device-token-hash'
import { parseMobilePushRegistration } from '../../../../../shared/notifications/mobile-push-contract'
import { isDevicePublicKeyB64 } from '../../../../../shared/remote-runtime/pairing/device-key-proof'
import { isExchangeDeviceToken } from '../../../../../shared/remote-runtime/pairing/ticket-exchange-contract'
import { RUNTIME_DEVICE_GRANTS, type RuntimeDeviceGrant } from '../../callers/rpc-method-permission'
import { isRecord } from '../../../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { NETWORK_SOURCE_CLASSES } from '../../transports/websocket/source-admission/network-source-class'

const GRANTABLE: ReadonlySet<string> = new Set(RUNTIME_DEVICE_GRANTS)

function isRuntimeDeviceGrant(value: unknown): value is RuntimeDeviceGrant {
  return typeof value === 'string' && GRANTABLE.has(value)
}

export function validGrants(value: unknown, scope: DeviceScope): RuntimeDeviceGrant[] | undefined {
  if (scope !== 'runtime' || !Array.isArray(value)) {
    return undefined
  }
  const grants = [...new Set(value.filter(isRuntimeDeviceGrant))].sort()
  return grants.length > 0 ? grants : undefined
}

export function validRelayBinding(
  value: unknown,
  deviceId: string
): RelayDeviceBinding | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  return value.relayDeviceId === deviceId &&
    typeof value.relayHostId === 'string' &&
    typeof value.ownerIdentityKey === 'string'
    ? {
        relayHostId: value.relayHostId,
        relayDeviceId: deviceId,
        ownerIdentityKey: value.ownerIdentityKey,
        ...(typeof value.inviteExpiresAt === 'number' && Number.isFinite(value.inviteExpiresAt)
          ? { inviteExpiresAt: value.inviteExpiresAt }
          : {})
      }
    : undefined
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function validOrcaAccount(value: unknown): DeviceOrcaAccount | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'name' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string'
    ? {
        id: value.id,
        name: value.name,
        ...('computer' in value && typeof value.computer === 'string' && value.computer
          ? { computer: value.computer }
          : {})
      }
    : undefined
}

function validTokenHash(value: unknown): string | undefined {
  return typeof value === 'string' && SHA256_HEX.test(value) ? value : undefined
}

/** Older registries kept bearer tokens in plain text; only the startup load hashes them in place. */
export type PlaintextTokenRows = 'migrate' | 'ignore'

/** Null for a row without a usable identity; the caller must treat the registry as doubtful.
 *  A plain-text token from anywhere but the startup migration stays inert, so a row written into the
 *  file later can't sign in with a token it names. */
export function normalizeLoadedDeviceRow(
  device: unknown,
  plaintext: PlaintextTokenRows = 'ignore'
): DeviceEntry | null {
  if (
    !isRecord(device) ||
    typeof device.deviceId !== 'string' ||
    !device.deviceId ||
    !isTimestamp(device.pairedAt) ||
    !isTimestamp(device.lastSeenAt)
  ) {
    return null
  }
  const legacyToken =
    plaintext === 'migrate' && typeof device.token === 'string' && device.token
      ? device.token
      : undefined
  const legacyExchange =
    plaintext === 'migrate' && isExchangeDeviceToken(device.exchangeToken)
      ? device.exchangeToken
      : undefined
  const { exchangeToken: _exchangeToken, ...stored } = device
  return {
    ...stored,
    deviceId: device.deviceId,
    name: typeof device.name === 'string' ? device.name : '',
    // Why: a malformed hash can never match, so the row stays listed but inert.
    tokenHash: legacyToken ? hashDeviceToken(legacyToken) : validTokenHash(device.tokenHash),
    // Kept in memory so this process can still hand it out (an unscanned offer, a relayed phone).
    token: legacyToken,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    lastSourceClass: NETWORK_SOURCE_CLASSES.find((value) => value === device.lastSourceClass),
    // Legacy registries held phones only; missing scope must not grant CLI powers.
    scope: device.scope === 'runtime' ? 'runtime' : 'mobile',
    grants: validGrants(device.grants, device.scope === 'runtime' ? 'runtime' : 'mobile'),
    relayBinding: validRelayBinding(device.relayBinding, device.deviceId),
    mobilePairingConnectionMode:
      device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic',
    // Older grants reached the network; preserve all-interface binding on reconnect.
    pairingReach: device.pairingReach === 'this-computer' ? 'this-computer' : 'network',
    // Bad push metadata must not fail registry load and strand all devices.
    pushRegistration: parseMobilePushRegistration(device.pushRegistration),
    parentDeviceId: typeof device.parentDeviceId === 'string' ? device.parentDeviceId : undefined,
    orcaAccount: validOrcaAccount(device.orcaAccount),
    phoneKey: typeof device.phoneKey === 'string' ? device.phoneKey : undefined,
    credentialRevision:
      typeof device.credentialRevision === 'number' &&
      Number.isSafeInteger(device.credentialRevision) &&
      device.credentialRevision > 0
        ? device.credentialRevision
        : undefined,
    callerFingerprint:
      typeof device.callerFingerprint === 'string' && device.callerFingerprint.length > 0
        ? device.callerFingerprint
        : undefined,
    // Unreadable expiry fails open to today's never-expiring offer.
    offerExpiresAt: isTimestamp(device.offerExpiresAt) ? device.offerExpiresAt : undefined,
    ticket: device.ticket === true ? true : undefined,
    exchangeTokenHash: legacyExchange
      ? hashDeviceToken(legacyExchange)
      : validTokenHash(device.exchangeTokenHash),
    ticketFirstSeenAt: isTimestamp(device.ticketFirstSeenAt) ? device.ticketFirstSeenAt : undefined,
    servesSessionBrowsers: device.servesSessionBrowsers === true ? true : undefined,
    createdByDeviceId:
      typeof device.createdByDeviceId === 'string' ? device.createdByDeviceId : undefined,
    originClientInstanceId:
      typeof device.originClientInstanceId === 'string' ? device.originClientInstanceId : undefined,
    hostStartOffer: device.hostStartOffer === true ? true : undefined,
    ...validDeviceKeyFields(device)
  }
}

// Malformed keyed rows stay keyed and unauthenticatable; never fall back to bearer auth.
function validDeviceKeyFields(
  device: Record<string, unknown>
): Pick<DeviceEntry, 'credentialKind' | 'devicePublicKeyB64' | 'forkedFrom' | 'ephemeral'> {
  if (device.credentialKind !== 'device-key') {
    return {
      credentialKind: undefined,
      devicePublicKeyB64: undefined,
      forkedFrom: undefined,
      ephemeral: undefined
    }
  }
  return {
    credentialKind: 'device-key',
    devicePublicKeyB64: isDevicePublicKeyB64(device.devicePublicKeyB64)
      ? device.devicePublicKeyB64
      : undefined,
    forkedFrom: typeof device.forkedFrom === 'string' ? device.forkedFrom : undefined,
    ephemeral: device.ephemeral === true ? true : undefined
  }
}
