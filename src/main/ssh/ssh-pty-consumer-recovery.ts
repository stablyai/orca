import { randomUUID } from 'node:crypto'
import type { SshPtyConsumerRecovery as PersistedRecovery } from '../../shared/ssh-types'
import type { SshPtyAcceptedSourceCheckpoint } from '../ipc/ssh-pty-output-source-obligations'
import type { SshPtyOutputMigrationResult } from '../ipc/ssh-pty-output-model-migration'
import type { Store } from '../persistence'
import type { SshPtyConsumerOwnerState } from './ssh-pty-consumer-session'

export type SshPtyConsumerRecoveryState = {
  clientInstanceId: string
  detached: boolean
  serverBuildId?: string
  owner?: SshPtyConsumerOwnerState
  checkpointsByAppPtyId: Map<string, SshPtyAcceptedSourceCheckpoint>
  modelMigrationsByAppPtyId: Map<string, Promise<SshPtyOutputMigrationResult>>
}

const recoveryByTarget = new Map<string, SshPtyConsumerRecoveryState>()

function ownerFromPersisted(record: PersistedRecovery): SshPtyConsumerOwnerState {
  return {
    mode: 'negotiated',
    clientInstanceId: record.clientInstanceId,
    clientGeneration: record.clientGeneration,
    ownerGeneration: record.ownerGeneration,
    ownerLease: record.ownerLease,
    ...(record.outputFlowControl ? { outputFlowControl: record.outputFlowControl } : {})
  }
}

export function claimSshPtyConsumerRecovery(
  targetId: string,
  store: Store
): SshPtyConsumerRecoveryState {
  const current = recoveryByTarget.get(targetId)
  if (current?.detached) {
    current.detached = false
    return current
  }
  const persisted = current ? null : store.getSshPtyConsumerRecovery(targetId)
  const created: SshPtyConsumerRecoveryState = {
    clientInstanceId: persisted?.clientInstanceId ?? randomUUID(),
    detached: false,
    ...(persisted
      ? { serverBuildId: persisted.serverBuildId, owner: ownerFromPersisted(persisted) }
      : {}),
    checkpointsByAppPtyId: new Map(),
    modelMigrationsByAppPtyId: new Map()
  }
  recoveryByTarget.set(targetId, created)
  return created
}

export function getSshPtyConsumerRecovery(
  targetId: string
): SshPtyConsumerRecoveryState | undefined {
  return recoveryByTarget.get(targetId)
}

export function rememberSshPtyConsumerRecovery(args: {
  targetId: string
  clientInstanceId: string
  serverBuildId: string
  owner: SshPtyConsumerOwnerState
  store: Store
}): void {
  const current = recoveryByTarget.get(args.targetId)
  if (current?.clientInstanceId !== args.clientInstanceId) {
    return
  }
  current.detached = false
  current.serverBuildId = args.serverBuildId
  current.owner = args.owner
  args.store.upsertSshPtyConsumerRecovery({
    targetId: args.targetId,
    clientInstanceId: args.clientInstanceId,
    serverBuildId: args.serverBuildId,
    clientGeneration: args.owner.clientGeneration,
    ownerGeneration: args.owner.ownerGeneration,
    ownerLease: args.owner.ownerLease,
    ...(args.owner.outputFlowControl ? { outputFlowControl: args.owner.outputFlowControl } : {})
  })
}

export function removeSshPtyConsumerOwnerRecovery(
  targetId: string,
  clientInstanceId: string,
  store: Store
): void {
  const persisted = store.getSshPtyConsumerRecovery(targetId)
  if (persisted?.clientInstanceId === clientInstanceId) {
    store.removeSshPtyConsumerRecovery(targetId)
  }
}

export function detachSshPtyConsumerRecovery(targetId: string, clientInstanceId: string): void {
  const current = recoveryByTarget.get(targetId)
  if (current?.clientInstanceId === clientInstanceId) {
    current.detached = true
  }
}

export function forgetSshPtyConsumerRecovery(
  targetId: string,
  clientInstanceId: string,
  store: Store
): void {
  const current = recoveryByTarget.get(targetId)
  if (current?.clientInstanceId === clientInstanceId) {
    recoveryByTarget.delete(targetId)
  }
  removeSshPtyConsumerOwnerRecovery(targetId, clientInstanceId, store)
}
