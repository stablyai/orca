import { RELAY_BUILD_PLATFORMS, type RelayBuildPlatform } from '../../shared/relay-artifacts'
import {
  parseSshConnectionDestination,
  type SshConnectionDestination
} from './ssh-connection-destination'
import {
  parseRelayResetPreparationBinding,
  type RelayResetPreparationBinding
} from '../../shared/relay-reset-preparation-contract'
import {
  parseRelayOwnerResetRequest,
  type RelayOwnerResetRequest
} from '../../shared/relay-owner-reset-contract'

export type SshRelayResetIntent = Readonly<{
  version: 1
  targetId: string
  targetGeneration: number
  targetRoutingDigest: string
  clientInstanceId: string
  serverBuildId: string
  destination?: SshConnectionDestination
  preparation?: RelayResetPreparationBinding
  endpoint: Readonly<{
    relayDir: string
    runtimePath: string
    runtimeKind: 'node' | 'bun'
    sockPath: string
    credentialFile: string
    relayPlatform: RelayBuildPlatform
  }>
  request: RelayOwnerResetRequest
}>

/** Intent is evidence of an attempted operation, never proof of host preparation or exit. */
export function parseSshRelayResetIntent(value: unknown): SshRelayResetIntent {
  const record = value as SshRelayResetIntent | null
  const text = (value: unknown, max = 8192): string => {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > max ||
      value.includes('\0')
    ) {
      throw new Error('ssh_relay_reset_intent_invalid')
    }
    return value
  }
  if (
    !record ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.targetGeneration) ||
    record.targetGeneration < 1 ||
    typeof record.targetRoutingDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.targetRoutingDigest) ||
    !record.endpoint ||
    !['node', 'bun'].includes(record.endpoint.runtimeKind) ||
    !RELAY_BUILD_PLATFORMS.includes(record.endpoint.relayPlatform)
  ) {
    throw new Error('ssh_relay_reset_intent_invalid')
  }
  const preparation =
    record.preparation === undefined
      ? undefined
      : parseRelayResetPreparationBinding(record.preparation)
  if (
    preparation &&
    (preparation.sockPath !== record.endpoint.sockPath ||
      preparation.serverBuildId !== record.serverBuildId)
  ) {
    throw new Error('ssh_relay_reset_preparation_binding_changed')
  }
  return Object.freeze({
    version: 1,
    targetId: text(record.targetId, 512),
    targetGeneration: record.targetGeneration,
    targetRoutingDigest: record.targetRoutingDigest,
    clientInstanceId: text(record.clientInstanceId, 512),
    serverBuildId: text(record.serverBuildId, 512),
    ...(record.destination === undefined
      ? {}
      : { destination: parseSshConnectionDestination(record.destination) }),
    ...(preparation ? { preparation } : {}),
    endpoint: Object.freeze({
      relayDir: text(record.endpoint.relayDir),
      runtimePath: text(record.endpoint.runtimePath),
      runtimeKind: record.endpoint.runtimeKind,
      sockPath: text(record.endpoint.sockPath),
      credentialFile: text(record.endpoint.credentialFile),
      relayPlatform: record.endpoint.relayPlatform
    }),
    request: parseRelayOwnerResetRequest(record.request)
  })
}
