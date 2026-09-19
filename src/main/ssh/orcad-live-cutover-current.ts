import type { Store } from '../persistence'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import type { bindOutgoingOrcadCatalogSource } from './orcad-outgoing-catalog-source'

export function assertOrcadLiveCutoverCurrent(options: {
  store: Store
  cutover: OrcadMigrationSourceCutover
  sourceAdmission: ReturnType<typeof bindOutgoingOrcadCatalogSource>
  signal: AbortSignal
  assertAuthority: () => void
}) {
  options.signal.throwIfAborted()
  options.assertAuthority()
  const { cutover } = options
  options.sourceAdmission.assertBindings(cutover.liveTerminalBindings)
  if (
    serializeOrcadMigrationValue(
      options.store.getOrcadMigrationSourceCutover(cutover.manifest.migrationId)
    ) !== serializeOrcadMigrationValue(cutover)
  ) {
    throw new Error('orcad_live_cutover_progress_stale')
  }
  if (
    options.store.inspectOrcadMigrationSourceDependencies(
      cutover.manifest,
      options.sourceAdmission.projectSourceState
    ).totalCount !== 0
  ) {
    throw new Error('orcad_migration_source_dependencies_present')
  }
}
