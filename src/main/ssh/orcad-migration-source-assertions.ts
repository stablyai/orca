/** Checks run before every stage and commit: the fenced source is still what the journal says. */
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import { resolveOrcadMigrationFence } from './orcad-migration-source-fence'
import { confirmOrcadMigrationTerminalsUnderFence } from './orcad-migration-terminal-gate'
import { collectUntransferredDependentBlockers } from './ssh-target-orcad-dependents'
import type { OrcadMigrationPreflightStore } from './ssh-target-orcad-preflight'

export function assertOrcadMigrationSourceUnchanged(
  context: { userDataPath: string; store: OrcadMigrationPreflightStore },
  cutover: OrcadMigrationSourceCutover
): void {
  const target = context.store.getSshTarget(cutover.sshTargetId)
  const fence = target ? resolveOrcadMigrationFence(context.userDataPath, target) : null
  if (!target || fence?.state !== 'fenced' || fence.cutover.migrationId !== cutover.migrationId) {
    throw new Error('orcad_migration_source_fence_lost')
  }
  // Same id, time and destination as the journaled export: any difference is a source change.
  const current = createOrcadMigrationManifest(context.store, target, {
    migrationId: cutover.migrationId,
    destinationEnvironmentId: cutover.destinationEnvironmentId,
    now: () => new Date(cutover.manifest.createdAt)
  })
  if (current.manifestSha256 !== cutover.manifestSha256) {
    throw new Error('orcad_migration_source_changed')
  }
  if (collectUntransferredDependentBlockers(context.store, cutover.manifest).length > 0) {
    throw new Error('orcad_migration_source_dependencies_present')
  }
  const terminals = confirmOrcadMigrationTerminalsUnderFence(context.store, target.id, {
    verdict: 'exited',
    provenPtyIds: cutover.provenPtyIds
  })
  if (terminals.verdict !== 'exited') {
    throw new Error(`orcad_migration_source_terminals_${terminals.verdict}`)
  }
}
