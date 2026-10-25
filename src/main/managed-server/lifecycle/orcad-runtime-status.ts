import type { OrcadManagedRuntimeStatus } from '../../../shared/orcad-managed-runtime'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import type { OrcadActivationTransaction } from '../activation/orcad-activation-transaction'
import { readOrcadActivationTransaction } from '../activation/orcad-activation-transaction-store'
import {
  requireManagedOrcadEnvironment,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'
import { currentManagedOrcadUpdateDeferral } from './orcad-managed-update-deferrals'
import { findIncompleteManagedOrcadMigration } from './orcad-managed-migration-status'
import { collectManagedTerminalCensus } from '../../ssh/orcad-terminal-census-client'
import { getAppEnvironment } from '../../../shared/app-environment'
import { bundledManagedOrcadVersion } from './orcad-managed-auto-update'
import { availableManagedOrcadUpdate } from './orcad-managed-update-decision'

/** Read host records without repairing them. */
export async function getManagedOrcadRuntimeStatus(
  userDataPath: string,
  selector: string,
  signal?: AbortSignal
): Promise<OrcadManagedRuntimeStatus> {
  const { environment, deployment } = requireManagedOrcadEnvironment(userDataPath, selector)
  const { status, record, serverTarget } = await runTargetLifecycle(
    deployment.sshTargetId,
    async () => {
      const context = await resolveLinkedOrcadContext(environment, deployment, signal)
      const record = context.activationRecord
      const transaction = await readOrcadActivationTransaction({
        conn: context.connection,
        host: context.host,
        remoteHome: context.remoteHome,
        signal
      })
      const status: OrcadManagedRuntimeStatus = {
        environmentId: environment.id,
        sshTargetId: context.target.id,
        activeVersion: record.active,
        activeAppVersion: record.active ? (record.activeAppVersion ?? null) : null,
        previousVersion: record.previous,
        activatedAt: record.activatedAt,
        rollbackAvailable: Boolean(record.previous && record.snapshot),
        recovery: transaction ? managedRecoveryStatus(transaction) : null,
        terminals: await collectManagedTerminalCensus(userDataPath, environment, record),
        migration: migrationStatus(userDataPath, environment.id),
        deferredUpdate: currentManagedOrcadUpdateDeferral(environment.id, record.active)
      }
      return { status, record, serverTarget: context.serverTarget }
    }
  )
  // Outside the host queue: hashing the local template must not hold up host actions.
  // A local template fault hides only the offer, never the host's status.
  const candidateVersion = await bundledManagedOrcadVersion(serverTarget).catch(() => null)
  return {
    ...status,
    availableUpdate: availableManagedOrcadUpdate({
      record,
      candidateVersion,
      appVersion: getAppEnvironment().getVersion(),
      deferredCandidateVersion: status.deferredUpdate?.candidateVersion ?? null
    })
  }
}

function managedRecoveryStatus(
  transaction: OrcadActivationTransaction
): NonNullable<OrcadManagedRuntimeStatus['recovery']> {
  switch (transaction.operation) {
    case 'activate':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.candidateVersion,
        startedAt: transaction.startedAt
      }
    case 'rollback':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.targetVersion,
        startedAt: transaction.startedAt
      }
    case 'decommission':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.activeVersion,
        startedAt: transaction.startedAt
      }
  }
}

function migrationStatus(
  userDataPath: string,
  environmentId: string
): OrcadManagedRuntimeStatus['migration'] {
  const migration = findIncompleteManagedOrcadMigration(userDataPath, environmentId)
  return migration
    ? { migrationId: migration.migrationId, phase: migration.phase, startedAt: migration.startedAt }
    : null
}
