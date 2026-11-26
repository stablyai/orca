import type { OrcadMigrationDormantStatePayload } from '../../../../../shared/orcad-migration/orcad-migration-manifest'

export function hasDormantState(state: OrcadMigrationDormantStatePayload): boolean {
  return (
    state.worktreeMeta.length > 0 ||
    state.worktreeLineage.length > 0 ||
    state.workspaceLineage.length > 0 ||
    state.sparsePresets.length > 0 ||
    state.retiredWorktreeNames.length > 0 ||
    state.retiredWorktreeNamespaces.length > 0 ||
    state.workspaceSession !== undefined ||
    (state.terminalScrollbackSnapshots?.length ?? 0) > 0 ||
    (state.automations?.length ?? 0) > 0 ||
    (state.automationRuns?.length ?? 0) > 0 ||
    state.automationRunHistory !== undefined ||
    (state.clientState !== undefined && Object.keys(state.clientState).length > 0)
  )
}
