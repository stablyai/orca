import {
  orcadMigrationAutomationRunHistoryBlob,
  withOrcadMigrationAutomationRunHistory
} from '../../../shared/orcad-migration/orcad-migration-automation-run-history'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { readOrcadMigrationBlob } from './orcad-migration-blob-staging'

/** The manifest signs the history's digest, so its rows import with the catalog or not at all. */
export function withStagedAutomationRunHistory(
  manifest: OrcadMigrationManifest,
  blobRoot: string
): OrcadMigrationManifest {
  const ref = manifest.payload.dormantState?.automationRunHistory
  if (!ref) {
    return manifest
  }
  const descriptor = orcadMigrationAutomationRunHistoryBlob(ref)
  return withOrcadMigrationAutomationRunHistory(
    manifest,
    readOrcadMigrationBlob(manifest, blobRoot, descriptor).toString('utf8')
  )
}
