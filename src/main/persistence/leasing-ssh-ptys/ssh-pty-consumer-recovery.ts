import type { SshPtyConsumerRecovery } from '../../../shared/ssh-types'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'
import type { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { sshPtyOwnerLeaseSecretSlot } from '../../protected-secret-persistence'
import { normalizeSshPtyConsumerRecovery } from './ssh-normalization'

export type SshPtyConsumerRecoveryOperations = {
  state: StoreOwnedPersistedState
  protectedSecrets: Pick<ProtectedSecretPersistence, 'isSealed' | 'removeRetainedBlob'>
  flushDurableStateOrThrowAsync: () => Promise<void>
}

async function flushSshPtyConsumerRecovery(
  operations: SshPtyConsumerRecoveryOperations
): Promise<void> {
  // Why: ownership must be durable before relay setup continues, but this runs on the live
  // establish/reconnect path — a sync flush would park the main thread on a stalled profile mount.
  // Why not caught here: the failure must reach the awaiting caller.
  await operations.flushDurableStateOrThrowAsync()
}

export function getSshPtyConsumerRecovery(
  operations: SshPtyConsumerRecoveryOperations,
  targetId: string
): SshPtyConsumerRecovery | null {
  const record = (operations.state.sshPtyConsumerRecoveries ?? []).find(
    (candidate) => candidate.targetId === targetId
  )
  if (
    record &&
    operations.protectedSecrets.isSealed(
      sshPtyOwnerLeaseSecretSlot(record.targetId),
      record.ownerLease
    )
  ) {
    return null
  }
  return record ? structuredClone(record) : null
}

export async function upsertSshPtyConsumerRecovery(
  operations: SshPtyConsumerRecoveryOperations,
  record: SshPtyConsumerRecovery
): Promise<void> {
  const normalized = normalizeSshPtyConsumerRecovery(record)
  if (!normalized) {
    throw new Error('Invalid SSH PTY consumer recovery record')
  }
  const recoveries = operations.state.sshPtyConsumerRecoveries ?? []
  operations.state.sshPtyConsumerRecoveries = [
    ...recoveries.filter((candidate) => candidate.targetId !== normalized.targetId),
    normalized
  ]
  await flushSshPtyConsumerRecovery(operations)
}

export async function removeSshPtyConsumerRecovery(
  operations: SshPtyConsumerRecoveryOperations,
  targetId: string
): Promise<void> {
  const recoveries = operations.state.sshPtyConsumerRecoveries ?? []
  const next = recoveries.filter((record) => record.targetId !== targetId)
  if (next.length === recoveries.length) {
    return
  }
  operations.state.sshPtyConsumerRecoveries = next
  operations.protectedSecrets.removeRetainedBlob(sshPtyOwnerLeaseSecretSlot(targetId))
  await flushSshPtyConsumerRecovery(operations)
}
