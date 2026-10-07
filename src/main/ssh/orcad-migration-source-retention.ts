/**
 * After commit: a migration keeps its source rows, so a downgraded build still sees the host and
 * its projects and can reach them over its own relay. New builds hide those rows and serve the host
 * from the server. They are never deleted automatically.
 */
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'

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
  // Why no baseline here: the source may have changed since the commit (a crash, then an older
  // build); only the fence's pre-commit baseline proves what the server holds.
  const retained = { ...cutover, sourceRetainedAt: now().toISOString() }
  writeOrcadMigrationSourceCutover(userDataPath, retained)
  return retained
}
