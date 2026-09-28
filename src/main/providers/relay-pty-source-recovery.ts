import {
  beginSshPtyOutputGenerationMigration,
  closeSshPtyOutputGeneration,
  getSshPtyAcceptedSourceCheckpoints
} from '../ipc/ssh-pty-output-intake-registry'
import type { SshPtyAcceptedSourceCheckpoint } from '../ipc/ssh-pty-output-source-obligations'
import type { SshPtyOutputMigrationResult } from '../ipc/ssh-pty-output-model-migration'
import type { PtySourceRecoveryRequest } from './ssh-pty-session-reattach'

export type RelayPtySourceRecovery = {
  checkpointsByAppPtyId: Map<string, SshPtyAcceptedSourceCheckpoint>
  modelMigrationsByAppPtyId: Map<string, Promise<SshPtyOutputMigrationResult>>
}

export async function relayPtySourceRecoveryRequest(
  recovery: RelayPtySourceRecovery | undefined,
  appPtyId: string,
  relayPtyId: string
): Promise<PtySourceRecoveryRequest> {
  const migration = recovery?.modelMigrationsByAppPtyId.get(appPtyId)
  if (migration) {
    const outcome = await migration
    if (recovery?.modelMigrationsByAppPtyId.get(appPtyId) === migration) {
      recovery.modelMigrationsByAppPtyId.delete(appPtyId)
    }
    if (outcome.status !== 'settled') {
      return Object.freeze({ status: 'checkpointUnavailable' })
    }
  }
  const checkpoints = recovery?.checkpointsByAppPtyId
  const checkpoint = checkpoints?.get(appPtyId) ?? checkpoints?.get(relayPtyId)
  if (!checkpoint) {
    return Object.freeze({ status: 'checkpointUnavailable' })
  }
  return Object.freeze({
    status: 'checkpoint',
    clientGeneration: checkpoint.clientGeneration,
    ownerGeneration: checkpoint.ownerGeneration,
    ptyIncarnation: checkpoint.ptyIncarnation,
    deliveryToken: checkpoint.deliveryToken,
    acceptedSourceEndSu: checkpoint.acceptedSourceEndSu
  })
}

/** Move accepted model obligations before retiring a replaceable relay transport. */
export function migrateRelayPtySourceGeneration(args: {
  generation: number
  closeReason: string
  getRecovery: () => RelayPtySourceRecovery | undefined
  toRelayPtyId: (id: string) => string
}): void {
  const { generation, closeReason, getRecovery, toRelayPtyId } = args
  const recovery = getRecovery()
  if (!recovery) {
    closeSshPtyOutputGeneration(generation, closeReason)
    return
  }
  for (const checkpoint of getSshPtyAcceptedSourceCheckpoints(generation)) {
    recovery.checkpointsByAppPtyId.set(checkpoint.id, checkpoint)
  }
  const migration = beginSshPtyOutputGenerationMigration(generation)
  for (const [ptyId, result] of migration.byPty) {
    const previous = recovery.modelMigrationsByAppPtyId.get(ptyId)
    const fence = previous ? previous.then(() => result) : result
    recovery.modelMigrationsByAppPtyId.set(ptyId, fence)
    void fence.then((outcome) => {
      const current = getRecovery()
      if (current?.modelMigrationsByAppPtyId.get(ptyId) !== fence) {
        return
      }
      if (outcome.status === 'settled') {
        current.checkpointsByAppPtyId.set(ptyId, outcome.checkpoint)
      } else {
        current.checkpointsByAppPtyId.delete(ptyId)
        current.checkpointsByAppPtyId.delete(toRelayPtyId(ptyId))
      }
      current.modelMigrationsByAppPtyId.delete(ptyId)
    })
  }
  void migration.completion.then(() => closeSshPtyOutputGeneration(generation, closeReason))
}

/** A rejected lease cannot authorize checkpoints captured under its previous generation. */
export function invalidateRelayPtySourceRecovery(recovery: RelayPtySourceRecovery): void {
  recovery.checkpointsByAppPtyId.clear()
  for (const [ptyId, migration] of recovery.modelMigrationsByAppPtyId) {
    recovery.modelMigrationsByAppPtyId.set(
      ptyId,
      migration.then(() =>
        Object.freeze({
          status: 'checkpoint-unavailable' as const,
          reason: 'completion-failed' as const
        })
      )
    )
  }
}
