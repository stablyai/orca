import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  orcadMigrationOwnerMatchesScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

export function collectOwnedTerminalTabIds(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope
): Set<string> {
  const tabIds = new Set(
    Object.entries(session.tabsByWorktree ?? {}).flatMap(([ownerKey, tabs]) =>
      orcadMigrationOwnerMatchesScope(ownerKey, scope) ? tabs.map((tab) => tab.id) : []
    )
  )
  for (const [ownerKey, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    if (!orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        tabIds.add(tab.id)
        tabIds.add(tab.entityId)
      }
    }
  }
  return tabIds
}
/** The terminal gate proves exit; move layouts without relay handles so destination shells start fresh. */
export function dropOrcadMigrationTerminalBindings(fragment: WorkspaceSessionState): void {
  for (const tabs of Object.values(fragment.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      tab.ptyId = null
    }
  }
  for (const layout of Object.values(fragment.terminalLayoutsByTabId ?? {})) {
    delete layout.ptyIdsByLeafId
  }
  delete fragment.remoteSessionIdsByTabId
  delete fragment.terminalPtyIncarnationsByPaneKey
  delete fragment.activeWorktreeIdsOnShutdown
  // Folder fences guarded relay PTYs; only repo fences migrate.
  for (const key of Object.keys(fragment.terminalTopologyRevisionByRepoId ?? {})) {
    if (parseWorkspaceKey(key)?.type === 'folder') {
      delete fragment.terminalTopologyRevisionByRepoId?.[key]
    }
  }
}
