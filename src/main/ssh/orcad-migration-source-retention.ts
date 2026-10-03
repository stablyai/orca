/**
 * Between commit and retirement: a committed migration keeps its source rows until source
 * retirement is switched on, so a downgraded build still sees the host and its projects and can
 * reach them over its own relay. New builds hide those rows and serve the host from the server.
 */
import { getAppEnvironment } from '../../shared/app-environment'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { isRolloutFlagActive } from '../updater/rollout-flags'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'

/** Baked off; the rollout payload turns it on two releases after the first auto-converting one. */
export function isOrcadSourceRetirementEnabled(): boolean {
  // Why no install id: retirement turns on for everyone at once, never as a percent cohort.
  return isRolloutFlagActive('orcad-source-retirement', {
    appVersion: getAppEnvironment().getVersion(),
    installId: null
  })
}

/** Marks a committed migration as finished for this build while its source rows stay. */
export function retainOrcadMigrationSource(
  userDataPath: string,
  migrationId: string,
  now: () => Date = () => new Date()
): OrcadMigrationSourceCutover {
  const cutover = listOrcadMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover || cutover.phase !== 'destination-committed') {
    throw new Error('orcad_migration_retain_before_commit')
  }
  if (cutover.sourceRetainedAt) {
    return cutover
  }
  const retained = { ...cutover, sourceRetainedAt: now().toISOString() }
  writeOrcadMigrationSourceCutover(userDataPath, retained)
  return retained
}
