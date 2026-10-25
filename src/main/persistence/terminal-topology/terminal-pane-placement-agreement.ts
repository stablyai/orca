import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'

/** Low-cardinality span attribute; absent tracks new leaves relying on legacy mint/graft placement. */
export type TerminalPanePlacementAgreement =
  | 'absent'
  | 'leaf_present'
  | 'agrees'
  | 'tab_exists'
  | 'tab_missing'
  | 'parent_missing'
  | 'root_occupied'
  | 'check_threw'

/** Compare placement before binding; reporting never changes the write. */
export function terminalPanePlacementAgreement(
  placement: TerminalPanePlacement | undefined,
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string,
  leafId: string
): TerminalPanePlacementAgreement {
  const tabExists = session.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId) === true
  const root = session.terminalLayoutsByTabId?.[tabId]?.root ?? null
  if (tabExists && layoutContainsLeafId(root, leafId)) {
    return 'leaf_present'
  }
  if (!placement) {
    return 'absent'
  }
  switch (placement.kind) {
    case 'new-tab':
      return tabExists ? 'tab_exists' : 'agrees'
    case 'root':
      return !tabExists ? 'tab_missing' : root ? 'root_occupied' : 'agrees'
    case 'split':
      return !tabExists
        ? 'tab_missing'
        : layoutContainsLeafId(root, placement.parentLeafId)
          ? 'agrees'
          : 'parent_missing'
  }
}
