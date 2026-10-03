import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  orcadMigrationOwnerMatchesScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

export function collectOwnedTerminalTabIds(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope
): Set<string> {
  const tabIds = new Set(
    Object.entries(session.tabsByWorktree).flatMap(([ownerKey, tabs]) =>
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

export function paneBelongsToTerminalLayout(
  record: SleepingAgentSessionRecord,
  session: WorkspaceSessionState,
  terminalTabIds: ReadonlySet<string>
): boolean {
  const separator = record.paneKey.lastIndexOf(':')
  if (separator < 1) {
    return false
  }
  const tabId = record.paneKey.slice(0, separator)
  const leafId = record.paneKey.slice(separator + 1)
  if ((record.tabId !== undefined && record.tabId !== tabId) || !terminalTabIds.has(tabId)) {
    return false
  }
  return terminalLayoutContainsLeaf(session.terminalLayoutsByTabId[tabId]?.root, leafId)
}

function terminalLayoutContainsLeaf(
  node: WorkspaceSessionState['terminalLayoutsByTabId'][string]['root'] | undefined,
  leafId: string
): boolean {
  return Boolean(
    node &&
    (node.type === 'leaf'
      ? node.leafId === leafId
      : terminalLayoutContainsLeaf(node.first, leafId) ||
        terminalLayoutContainsLeaf(node.second, leafId))
  )
}

export function paneBelongsToTabs(paneKey: string, tabIds: ReadonlySet<string>): boolean {
  const separator = paneKey.lastIndexOf(':')
  return separator > 0 && tabIds.has(paneKey.slice(0, separator))
}
