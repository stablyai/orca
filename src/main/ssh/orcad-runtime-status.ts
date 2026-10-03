import type { OrcadManagedRuntimeStatus } from '../../shared/orcad-managed-runtime'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import type { OrcadActivationTransaction } from './orcad-activation-transaction'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import {
  requireManagedOrcadEnvironment,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'
import { readManagedOrcadUpdateDeferral } from './orcad-managed-update-deferrals'
import { findIncompleteManagedOrcadMigration } from './orcad-managed-migration-status'
import { collectManagedTerminalCensus } from './orcad-terminal-census-client'

/** Read-only: what the host's activation record and journal say, without repairing either. */
export async function getManagedOrcadRuntimeStatus(
  userDataPath: string,
  selector: string,
  signal?: AbortSignal
): Promise<OrcadManagedRuntimeStatus> {
  const { environment, deployment } = requireManagedOrcadEnvironment(userDataPath, selector)
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    const context = await resolveLinkedOrcadContext(environment, deployment, signal)
    const record = context.activationRecord
    const transaction = await readOrcadActivationTransaction({
      conn: context.connection,
      host: context.host,
      remoteHome: context.remoteHome,
      signal
    })
    return {
      environmentId: environment.id,
      sshTargetId: context.target.id,
      activeVersion: record.active,
      previousVersion: record.previous,
      activatedAt: record.activatedAt,
      rollbackAvailable: Boolean(record.previous && record.snapshot),
      recovery: transaction ? managedRecoveryStatus(transaction) : null,
      terminals: await collectManagedTerminalCensus(userDataPath, environment, record),
      migration: migrationStatus(userDataPath, environment.id),
      deferredUpdate: readManagedOrcadUpdateDeferral(environment.id)
    }
  })
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
