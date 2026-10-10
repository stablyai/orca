import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { SshPtyConsumerRecovery } from '../../../shared/ssh-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { sshPtyOwnerLeaseSecretSlot } from '../../protected-secret-persistence'
import { normalizeSshPtyConsumerRecovery } from './ssh-normalization'

export type SshPtyConsumerRecoveryOperations = {
  state: PersistedState
  protectedSecrets: Pick<ProtectedSecretPersistence, 'isSealed' | 'removeRetainedBlob'>
  runDurableMutation: StoreRuntimeState['runDurableMutation']
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
  await operations.runDurableMutation(() => {
    const recoveries = operations.state.sshPtyConsumerRecoveries ?? []
    operations.state.sshPtyConsumerRecoveries = [
      ...recoveries.filter((candidate) => candidate.targetId !== normalized.targetId),
      normalized
    ]
    return { value: undefined }
  })
}

export async function removeSshPtyConsumerRecovery(
  operations: SshPtyConsumerRecoveryOperations,
  targetId: string,
  expectedClientInstanceId?: string
): Promise<void> {
  await operations.runDurableMutation(() => {
    const recoveries = operations.state.sshPtyConsumerRecoveries ?? []
    const current = recoveries.find((record) => record.targetId === targetId)
    if (
      expectedClientInstanceId !== undefined &&
      current &&
      current.clientInstanceId !== expectedClientInstanceId
    ) {
      return { value: undefined, persist: false }
    }
    operations.state.sshPtyConsumerRecoveries = recoveries.filter(
      (record) => record.targetId !== targetId
    )
    return { value: undefined }
  })
  if (!operations.state.sshPtyConsumerRecoveries?.some((record) => record.targetId === targetId)) {
    operations.protectedSecrets.removeRetainedBlob(sshPtyOwnerLeaseSecretSlot(targetId))
  }
}
