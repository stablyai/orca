import {
  isRetainedOrcadMigrationSourceCutover,
  type OrcadMigrationSourceCutover
} from '../../../shared/orcad-migration/orcad-migration-source-cutover'
import {
  getOrcadSshDeployment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { listOrcadMigrationSourceCutovers } from '../../ssh/orcad-migration-cutover-journal'

type OrcadManagedPendingMigration = {
  migrationId: string
  environmentId: string
  name: string
  sshTargetId: string
  phase: OrcadMigrationSourceCutover['phase']
  startedAt: string
}

/** Unreadable journals must not look like absent migrations. */
export function listPendingManagedOrcadMigrations(
  userDataPath: string
): OrcadManagedPendingMigration[] {
  return (
    listOrcadMigrationSourceCutovers(userDataPath)
      // Committed/retained journals preserve downgrade recovery, not pending migration work.
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

export function environmentMatchesManagedOrcadCutover(
  environment: KnownRuntimeEnvironment,
  cutover: OrcadMigrationSourceCutover
): boolean {
  const deployment = getOrcadSshDeployment(environment)
  return (
    environment.id === cutover.destinationEnvironmentId &&
    environment.name === cutover.destinationName &&
    deployment?.sshTargetId === cutover.sshTargetId &&
    deployment.sshTargetGeneration === cutover.sshTargetGeneration
  )
}
