import type { RuntimeSyncedTab } from '../../../shared/runtime-types'
import type { RuntimeLeafRecord } from '../runtime-terminal-state-records'

export function visibleGraphChangedWorktrees(
  previousTabs: ReadonlyMap<string, RuntimeSyncedTab>,
  previousLeaves: ReadonlyMap<string, RuntimeLeafRecord>,
  tabs: ReadonlyMap<string, RuntimeSyncedTab>,
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
): Set<string> {
  const changed = new Set<string>()
  for (const [tabId, tab] of tabs) {
    const prev = previousTabs.get(tabId)
    if (!prev || prev.title !== tab.title) {
      changed.add(tab.worktreeId)
    }
  }
  for (const [tabId, tab] of previousTabs) {
    if (!tabs.has(tabId)) {
      changed.add(tab.worktreeId)
    }
  }
  for (const [leafKey, leaf] of leaves) {
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
    if (!leaves.has(leafKey)) {
      changed.add(leaf.worktreeId)
    }
  }
  return changed
}
