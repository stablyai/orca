import {
  hasModernAutomationLaunchSetup,
  automationCanonicalLaunchSetup
} from '../../shared/automation-launch-setup'
import { AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY } from '../../shared/automation-runtime-capabilities'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest'
import { ORCAD_MIGRATION_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'

/** Refuse older destinations that would silently drop links to parents in other stores. */
export const ORCAD_MIGRATION_DESTINATION_CROSS_STORE_LINEAGE_UNSUPPORTED =
  'orcad_migration_destination_cross_store_lineage_unsupported:Update Orca on this host to move workspaces whose parent is on another machine.'

/** Refuses an importing destination that would silently drop parts of this payload. */
export function assertDestinationKeepsMigrationPayload(
  manifest: OrcadMigrationManifest,
  capabilities: readonly string[]
): void {
  const dormantState = manifest.payload.dormantState
  if (
    (dormantState?.crossStoreLineage?.length ?? 0) > 0 &&
    !capabilities.includes(ORCAD_MIGRATION_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY)
  ) {
    throw new Error(ORCAD_MIGRATION_DESTINATION_CROSS_STORE_LINEAGE_UNSUPPORTED)
  }
  if (
    (dormantState?.automations ?? []).some((automation) =>
      hasModernAutomationLaunchSetup(automationCanonicalLaunchSetup(automation))
    ) &&
    !capabilities.includes(AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY)
  ) {
    throw new Error('Update Orca on the destination host to keep automation agent launch settings.')
  }
}
