import { createHash, randomUUID } from 'node:crypto'
import type { SshTarget } from '../../shared/ssh-types'
import { readRelayOwnerResetIncarnation } from '../../shared/relay-owner-reset-contract'
import { readRelayResetPreparationBinding } from '../../shared/relay-reset-preparation-contract'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { SshPtyConsumerOwnerState } from './ssh-pty-consumer-session'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from './ssh-relay-reset-intent'
import {
  parseSshConnectionDestination,
  type SshConnectionDestination
} from './ssh-connection-destination'

export function sshRelayResetTargetRoutingDigest(target: SshTarget): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        host: target.host,
        port: target.port,
        username: target.username,
        configHost: target.configHost ?? null,
        proxyCommand: target.proxyCommand ?? null,
        jumpHost: target.jumpHost ?? null,
        identityFile: target.identityFile ?? null,
        identityAgent: target.identityAgent ?? null,
        identitiesOnly: target.identitiesOnly ?? null,
        gssapiAuthentication: target.gssapiAuthentication ?? null,
        systemSshConnectionReuse: target.systemSshConnectionReuse ?? null
      })
    )
    .digest('hex')
}

export type SshRelayResetSessionSnapshot = {
  connectedTarget: SshTarget
  mux: Pick<SshChannelMultiplexer, 'request' | 'isDisposed'>
  owner: SshPtyConsumerOwnerState
  serverBuildId: string
  endpoint: SshRelayResetIntent['endpoint']
  destination?: SshConnectionDestination
  connection?: object
  transportGeneration?: number
}

/** Only a live admitted consumer can create or retry initial reset authority. */
export async function captureSshRelayResetSessionBinding(options: {
  readTarget: () => SshTarget | undefined
  readSession: () => SshRelayResetSessionSnapshot | null
  existing?: SshRelayResetIntent
}) {
  const expected = options.existing ? parseSshRelayResetIntent(options.existing) : undefined
  const target = options.readTarget()
  const snapshot = options.readSession()
  if (!target || !snapshot || snapshot.mux.isDisposed()) {
    throw new Error('ssh_relay_reset_active_owner_unavailable')
  }
  const mux = snapshot.mux
  const connection = snapshot.connection
  const transportGeneration = snapshot.transportGeneration
  const destination = snapshot.destination
    ? parseSshConnectionDestination(snapshot.destination)
    : undefined
  const destinationJson = JSON.stringify(destination)
  const binding = {
    version: 1 as const,
    targetId: target.id,
    targetGeneration: target.generation!,
    targetRoutingDigest: sshRelayResetTargetRoutingDigest(target),
    clientInstanceId: snapshot.owner.clientInstanceId,
    serverBuildId: snapshot.serverBuildId,
    endpoint: { ...snapshot.endpoint }
  }
  const owner = { ...snapshot.owner }
  const assertAuthority = () => {
    const currentTarget = options.readTarget()
    const current = options.readSession()
    if (
      !currentTarget ||
      !current ||
      current.mux !== mux ||
      current.connection !== connection ||
      current.transportGeneration !== transportGeneration ||
      JSON.stringify(
        current.destination ? parseSshConnectionDestination(current.destination) : undefined
      ) !== destinationJson ||
      current.mux.isDisposed() ||
      currentTarget.id !== binding.targetId ||
      currentTarget.generation !== binding.targetGeneration ||
      sshRelayResetTargetRoutingDigest(currentTarget) !== binding.targetRoutingDigest ||
      current.connectedTarget.id !== binding.targetId ||
      current.connectedTarget.generation !== binding.targetGeneration ||
      sshRelayResetTargetRoutingDigest(current.connectedTarget) !== binding.targetRoutingDigest ||
      current.serverBuildId !== binding.serverBuildId ||
      current.owner.clientInstanceId !== owner.clientInstanceId ||
      current.owner.clientGeneration !== owner.clientGeneration ||
      current.owner.ownerGeneration !== owner.ownerGeneration ||
      current.owner.ownerLease !== owner.ownerLease ||
      Object.entries(binding.endpoint).some(
        ([key, value]) => current.endpoint[key as keyof typeof current.endpoint] !== value
      )
    ) {
      throw new Error('ssh_relay_reset_session_binding_changed')
    }
  }
  assertAuthority()
  const status = await mux.request('relay.status')
  assertAuthority()
  const runtimeIncarnation = readRelayOwnerResetIncarnation(status)
  const preparation = readRelayResetPreparationBinding(status)
  if (
    preparation &&
    (preparation.sockPath !== binding.endpoint.sockPath ||
      preparation.serverBuildId !== binding.serverBuildId)
  ) {
    throw new Error('ssh_relay_reset_preparation_binding_changed')
  }
  const intent = parseSshRelayResetIntent({
    ...binding,
    ...(destination ? { destination } : {}),
    ...(preparation ? { preparation } : {}),
    request: {
      version: 1,
      operationId: expected?.request.operationId ?? randomUUID(),
      runtimeIncarnation,
      ownerGeneration: owner.ownerGeneration,
      ownerLease: owner.ownerLease
    }
  })
  if (expected && JSON.stringify(expected) !== JSON.stringify(intent)) {
    throw new Error('ssh_relay_reset_intent_binding_changed')
  }
  return { intent, mux, assertAuthority }
}
