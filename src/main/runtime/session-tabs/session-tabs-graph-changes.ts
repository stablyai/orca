import type { RuntimeSyncedTab } from '../../../shared/runtime-types'
import type { RuntimeLeafRecord } from '../runtime-terminal-state-records'
import { OrcaRuntimeWithSyncWindowGraph } from '../session-graph/session-window-graph'

export abstract class RuntimeSessionTabsGraphChanges extends OrcaRuntimeWithSyncWindowGraph {
  // Graph changes can alter projected handles/titles without changing snapshot bytes; compare projection fields and fan out affected workspaces.
  protected collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    const changed = new Set<string>()
    for (const [tabId, tab] of this.tabs) {
      const prev = previousTabs.get(tabId)
      if (!prev || prev.title !== tab.title) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [tabId, tab] of previousTabs) {
      if (!this.tabs.has(tabId)) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [leafKey, leaf] of this.leaves) {
      const prev = previousLeaves.get(leafKey)
      if (
        !prev ||
        prev.ptyId !== leaf.ptyId ||
        prev.connected !== leaf.connected ||
        prev.paneTitle !== leaf.paneTitle
      ) {
        changed.add(leaf.worktreeId)
      }
    }
    for (const [leafKey, leaf] of previousLeaves) {
      if (!this.leaves.has(leafKey)) {
        changed.add(leaf.worktreeId)
      }
    }
    return changed
  }
}
