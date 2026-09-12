import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { OrcadMigrationSourceCutover } from '../../../shared/orcad-migration-source-cutover'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { createOrcadMigrationSourceScope } from './orcad-source-scope'
import { projectOrcadSourceLiveSession } from './orcad-source-live-session-projection'

/** Comparison clones only; saved JSON is never installed as profile state. */
export function assertOrcadLiveSuccessorTabBindingChange(
  before: string | null,
  after: string | null,
  field: 'workspaceSession' | 'workspaceSessionsByHostId',
  cutover: OrcadMigrationSourceCutover
) {
  if (before === after) {
    return
  }
  if (before === null || after === null) {
    throw new Error('orcad_live_successor_profile_before_conflict')
  }
  const previous = JSON.parse(before)
  const comparison = JSON.parse(after)
  const scope = createOrcadMigrationSourceScope({
    source: cutover.manifest.source,
    catalog: cutover.manifest.payload
  })
  const tabIds = new Set(
    cutover.liveTerminalBindings!.map(({ surfaceBinding }) => surfaceBinding.tabId)
  )
  const reconcile = (original: WorkspaceSessionState, current: WorkspaceSessionState) => {
    if (!original || !current) {
      return
    }
    for (const tabId of tabIds) {
      const originals = Object.values(original.tabsByWorktree)
        .flat()
        .filter((tab) => tab.id === tabId)
      const changed = Object.values(current.tabsByWorktree)
        .flat()
        .filter((tab) => tab.id === tabId)
      if (originals.length === 0 && changed.length === 0) {
        continue
      }
      if (originals.length !== 1 || changed.length !== 1) {
        throw new Error('orcad_live_successor_profile_before_conflict')
      }
      if (originals[0].ptyId === changed[0].ptyId) {
        continue
      }
      const bindings = cutover.liveTerminalBindings!.filter(
        ({ surfaceBinding }) => surfaceBinding.tabId === tabId
      )
      const ptys = new Set(
        bindings.map(({ identity }) => toAppSshPtyId(scope.targetId, identity.terminalId))
      )
      if (
        !originals[0].ptyId ||
        !changed[0].ptyId ||
        !ptys.has(originals[0].ptyId) ||
        !ptys.has(changed[0].ptyId)
      ) {
        throw new Error('orcad_live_successor_profile_before_conflict')
      }
      projectOrcadSourceLiveSession(original, scope, bindings)
      projectOrcadSourceLiveSession(current, scope, bindings)
      changed[0].ptyId = originals[0].ptyId
    }
  }
  if (field === 'workspaceSession') {
    reconcile(previous, comparison)
  } else {
    reconcile(previous[scope.hostId], comparison[scope.hostId])
  }
  if (serializeOrcadMigrationValue(previous) !== serializeOrcadMigrationValue(comparison)) {
    throw new Error('orcad_live_successor_profile_before_conflict')
  }
}
