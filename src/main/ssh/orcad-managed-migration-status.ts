/** Which dormant migrations into managed servers have not finished, for status and resume. */
import {
  isRetainedOrcadMigrationSourceCutover,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'

export type OrcadManagedPendingMigration = {
  migrationId: string
  environmentId: string
  name: string
  sshTargetId: string
  phase: OrcadMigrationSourceCutover['phase']
  startedAt: string
}

/** Throws on an unreadable journal: a migration we cannot read is not "none". */
export function listPendingManagedOrcadMigrations(
  userDataPath: string
): OrcadManagedPendingMigration[] {
  return (
    listOrcadMigrationSourceCutovers(userDataPath)
      // Why retained too: committed is finished; keeping source rows is downgrade insurance, not work.
      .filter(
        (cutover) =>
          cutover.phase !== 'source-retired' && !isRetainedOrcadMigrationSourceCutover(cutover)
      )
      .map((cutover) => ({
        migrationId: cutover.migrationId,
        environmentId: cutover.destinationEnvironmentId,
        name: cutover.destinationName,
        sshTargetId: cutover.sshTargetId,
        phase: cutover.phase,
        startedAt: cutover.startedAt
      }))
  )
}

export function findIncompleteManagedOrcadMigration(
  userDataPath: string,
  environmentId: string
): OrcadManagedPendingMigration | null {
  return (
    listPendingManagedOrcadMigrations(userDataPath).find(
      (migration) => migration.environmentId === environmentId
    ) ?? null
  )
}

/** The registered server is the one the journal deploys into, on the journaled registration. */
export function environmentMatchesManagedOrcadCutover(
  environment: KnownRuntimeEnvironment,
  cutover: OrcadMigrationSourceCutover
): boolean {
  return (
    environment.id === cutover.destinationEnvironmentId &&
    environment.name === cutover.destinationName &&
    environment.orcadDeployment?.sshTargetId === cutover.sshTargetId &&
    environment.orcadDeployment.sshTargetGeneration === cutover.sshTargetGeneration
  )
}
