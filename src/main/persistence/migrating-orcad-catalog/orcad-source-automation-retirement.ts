import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'

export function retireOrcadMigrationSourceAutomationState(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const automations = manifest.payload.dormantState?.automations ?? []
  const automationRuns = manifest.payload.dormantState?.automationRuns ?? []
  if (automations.length === 0 && automationRuns.length === 0) {
    return
  }
  const automationIds = new Set(automations.map((entry) => entry.id))
  const runIds = new Set(automationRuns.map((entry) => entry.id))
  state.automations = state.automations.filter((entry) => !automationIds.has(entry.id))
  state.automationRuns = state.automationRuns.filter((entry) => !runIds.has(entry.id))
}

export function assertOrcadMigrationSourceAutomationStateRetired(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const automationIds = new Set(
    (manifest.payload.dormantState?.automations ?? []).map((entry) => entry.id)
  )
  const runIds = new Set(
    (manifest.payload.dormantState?.automationRuns ?? []).map((entry) => entry.id)
  )
  if (
    state.automations.some((entry) => automationIds.has(entry.id)) ||
    state.automationRuns.some((entry) => runIds.has(entry.id))
  ) {
    throw new Error('orcad_migration_source_automation_state_reappeared')
  }
}
