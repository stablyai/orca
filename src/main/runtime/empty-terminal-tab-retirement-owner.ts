import type { RuntimeMobileSessionTabsSnapshot, RuntimeSyncedTab } from '../../shared/runtime-types'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { deriveHeadlessLegacyTerminalLeafId } from './mobile-session-layout-projection'

export type EmptyTabRuntimeOwners = {
  tabs: ReadonlyMap<string, RuntimeSyncedTab>
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  mobileSessionTabsByWorktree: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
}

export function hasEmptyTerminalTabRetirementOwner(
  host: EmptyTabRuntimeOwners,
  worktreeId: string,
  tabId: string
): boolean {
  const graphTab = host.tabs.get(tabId)
  if (
    graphTab &&
    (graphTab.worktreeId !== worktreeId ||
      graphTab.layout !== null ||
      graphTab.activeLeafId !== null)
  ) {
    return true
  }
  for (const leaf of host.leaves.values()) {
    if (leaf.tabId === tabId) {
      return true
    }
  }
  for (const pty of host.ptysById.values()) {
    if (pty.tabId === tabId || parsePaneKey(pty.paneKey ?? '')?.tabId === tabId) {
      return true
    }
  }
  for (const [workspace, snapshot] of host.mobileSessionTabsByWorktree) {
    for (const tab of snapshot.tabs) {
      if (tab.type !== 'terminal' || tab.parentTabId !== tabId) {
        continue
      }
      if (
        workspace !== worktreeId ||
        tab.isPinned ||
        tab.viewMode === 'chat' ||
        tab.ptyId ||
        tab.parentLayout?.root ||
        Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {}).some(Boolean) ||
        tab.leafId !== deriveHeadlessLegacyTerminalLeafId(tabId)
      ) {
        return true
      }
    }
  }
  return false
}
