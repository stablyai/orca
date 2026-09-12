import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  getPreferredLoopbackRuntimePort,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import type { OrcadManagedPendingMigration } from '../../shared/orcad-managed-runtime'
import type { OrcadMigrationPreflight } from '../../shared/orcad-migration-preflight'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { requireManagedOrcadTargetStore } from './orcad-managed-runtime-context'

export function preflightManagedOrcadTarget(sshTargetId: string): OrcadMigrationPreflight {
  return requireManagedOrcadTargetStore().preflightOrcadRuntimeTarget(sshTargetId)
}

export function listPendingManagedOrcadMigrations(
  userDataPath: string
): OrcadManagedPendingMigration[] {
  const environments = listEnvironments(userDataPath)
  const targetStore = requireManagedOrcadTargetStore()
  return targetStore
    .getOrcadMigrationStore()
    .listOrcadMigrationSourceCutovers()
    .filter(
      (cutover) =>
        !environments.some((environment) =>
          environmentMatchesManagedOrcadCutover(environment, cutover)
        )
    )
    .filter((cutover) => {
      if (cutover.phase !== 'source-retired') {
        return true
      }
      const target = targetStore.getTarget(cutover.manifest.source.sshTargetId)
      // Why: a retained fence means registration crashed; an existing unowned target was intentionally unlinked.
      return !target || target.owner !== undefined
    })
    .map((cutover) => ({
      environmentId: cutover.destinationEnvironmentId,
      name: cutover.destinationName ?? cutover.manifest.source.targetLabel,
      sshTargetId: cutover.manifest.source.sshTargetId,
      sshTargetLabel: cutover.manifest.source.targetLabel,
      phase: cutover.phase,
      startedAt: cutover.startedAt
    }))
}

export function environmentMatchesManagedOrcadCutover(
  environment: KnownRuntimeEnvironment,
  cutover: OrcadMigrationSourceCutover,
  expectedTargetGeneration?: number
): boolean {
  const deployment = environment.orcadDeployment
  const source = cutover.manifest.source
  return (
    environment.id === cutover.destinationEnvironmentId &&
    (cutover.destinationName === undefined || environment.name === cutover.destinationName) &&
    environment.connectionDependency === 'ssh-tunnel' &&
    deployment !== undefined &&
    deployment.sshTargetId === source.sshTargetId &&
    (source.sshTargetGeneration === null ||
      deployment.sshTargetGeneration === source.sshTargetGeneration) &&
    (expectedTargetGeneration === undefined ||
      deployment.sshTargetGeneration === expectedTargetGeneration) &&
    deployment.localPort === getPreferredLoopbackRuntimePort(environment) &&
    deployment.remotePort === ORCAD_MANAGED_REMOTE_PORT
  )
}

export function findIncompleteManagedOrcadMigration(
  environment: KnownRuntimeEnvironment
): OrcadMigrationSourceCutover | null {
  const deployment = environment.orcadDeployment
  if (!deployment) {
    return null
  }
  return (
    requireManagedOrcadTargetStore()
      .getOrcadMigrationStore()
      .listOrcadMigrationSourceCutovers()
      .find(
        (cutover) =>
          cutover.destinationEnvironmentId === environment.id &&
          cutover.manifest.source.sshTargetId === deployment.sshTargetId &&
          cutover.phase !== 'source-retired'
      ) ?? null
  )
}
