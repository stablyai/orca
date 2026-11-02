import type {
  AgentStatusEntry,
  MigrationUnsupportedPtyEntry
} from '../../../shared/agent-status-types'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedTab
} from '../../../shared/runtime-types'
import type { SmartSortSources } from '../../../shared/sidebar-list/smart-sort'
import type { RuntimeLeafRecord } from '../runtime-terminal-state-records'

/**
 * The window's Smart inputs, rebuilt from a runtime's records: graph tabs carry titles and pane
 * trees, leaves carry bindings and pane titles, and session snapshots list tabs nothing mounts.
 */
export function buildRuntimeSmartSortSources(records: {
  tabs: Iterable<RuntimeSyncedTab>
  leaves: Iterable<
    Pick<RuntimeLeafRecord, 'tabId' | 'ptyId' | 'connected' | 'paneRuntimeId' | 'paneTitle'>
  >
  sessionTabs: Iterable<
    [worktreeId: string, snapshot: Pick<RuntimeMobileSessionTabsSnapshot, 'tabs'>]
  >
  /** The window holds no unverifiable state: a binding whose host lost contact is live there. */
  isUnverifiablePty: (ptyId: string) => boolean
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  migrationUnsupported: Iterable<MigrationUnsupportedPtyEntry>
}): SmartSortSources {
  const tabsByWorktree: Record<string, { id: string; title: string }[]> = {}
  const tabIds = new Set<string>()
  const addTab = (worktreeId: string, id: string, title: string): void => {
    if (!tabIds.has(id)) {
      tabIds.add(id)
      ;(tabsByWorktree[worktreeId] ??= []).push({ id, title })
    }
  }
  const terminalLayoutsByTabId: NonNullable<SmartSortSources['terminalLayoutsByTabId']> = {}
  for (const tab of records.tabs) {
    addTab(tab.worktreeId, tab.tabId, tab.title ?? '')
    terminalLayoutsByTabId[tab.tabId] = {
      root: tab.layout,
      activeLeafId: tab.activeLeafId,
      expandedLeafId: null
    }
  }
  for (const [worktreeId, snapshot] of records.sessionTabs) {
    for (const tab of snapshot.tabs) {
      if (tab.type === 'terminal') {
        addTab(worktreeId, tab.parentTabId, tab.title)
      }
    }
  }
  const ptyIdsByTabId: Record<string, string[]> = {}
  const runtimePaneTitlesByTabId: Record<string, Record<number, string>> = {}
  for (const leaf of records.leaves) {
    if (leaf.ptyId && (leaf.connected || records.isUnverifiablePty(leaf.ptyId))) {
      ;(ptyIdsByTabId[leaf.tabId] ??= []).push(leaf.ptyId)
    }
    if (leaf.paneTitle) {
      ;(runtimePaneTitlesByTabId[leaf.tabId] ??= {})[leaf.paneRuntimeId] = leaf.paneTitle
    }
  }
  const migrationUnsupportedByPtyId: Record<string, MigrationUnsupportedPtyEntry> = {}
  for (const entry of records.migrationUnsupported) {
    migrationUnsupportedByPtyId[entry.ptyId] = entry
  }
  return {
    tabsByWorktree,
    agentStatusByPaneKey: records.agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    migrationUnsupportedByPtyId,
    terminalLayoutsByTabId
  }
}
