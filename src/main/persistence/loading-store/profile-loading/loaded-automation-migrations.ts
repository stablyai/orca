import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import { backfillLegacyAutomationContexts } from '../../scheduling-automations/automation-context-migration'
import { migrateAutomationOwners } from '../../../automations/ownership/automation-owner-migration'
import { reseedLoadedAutomationZones } from '../../scheduling-automations/automation-zone-reseed'
import type { StoreRuntimeState } from '../store-runtime-state'

/**
 * A loaded profile's automations: legacy run contexts backfilled, owners migrated, and next runs an
 * older Orca saved on the host clock re-seeded on their zone. Any change marks the load for saving.
 */
export function migrateLoadedAutomations<T extends PersistedState>(
  loaded: T,
  projects: Pick<PersistedState, 'repos' | 'projectHostSetups'>,
  runtime: Pick<StoreRuntimeState, 'loadNeedsSave' | 'storageAuthority'>
): T {
  const contexts = backfillLegacyAutomationContexts({ ...loaded, ...projects })
  if (contexts.changed) {
    runtime.loadNeedsSave = true
  }
  const owners = migrateAutomationOwners({
    automations: contexts.state.automations,
    sshTargets: loaded.sshTargets,
    repos: projects.repos,
    folderWorkspaces: loaded.folderWorkspaces,
    projectGroups: loaded.projectGroups,
    sshTargetGenerationCounter: loaded.sshTargetGenerationCounter,
    storageAuthority: runtime.storageAuthority
  })
  if (owners.changed) {
    runtime.loadNeedsSave = true
  }
  return reseedLoadedAutomationZones(
    {
      ...loaded,
      automations: owners.automations,
      automationRuns: contexts.state.automationRuns,
      sshTargets: owners.sshTargets,
      sshTargetGenerationCounter: owners.sshTargetGenerationCounter
    },
    runtime
  )
}
