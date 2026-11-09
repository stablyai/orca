import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { useAppStore } from '../store'
import { getHoveredWorkspaceIdentity } from '../components/sidebar/workspace-actions/deletion/hovered-workspace-delete'
import { requestWorkspaceSleep } from '../components/sidebar/workspace-actions/sleep/sleep-twin-confirmation'
import { runSleepWorktrees } from '../components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import { resolveWorkspaceSleepShortcutTargets } from '../components/sidebar/workspace-actions/sleep/workspace-sleep-shortcut-targets'
import { getPublishedSidebarSelection } from '../components/sidebar/worktree-list/navigation/published-sidebar-selection'

export function createWorkspaceSleepShortcutHandler(
  floatingWorkspaceFocused: boolean,
  claim: (run: () => void) => boolean
): () => boolean {
  return () => {
    const store = useAppStore.getState()
    // Locally controlled dialogs do not set activeModal.
    if (
      store.activeModal !== 'none' ||
      floatingWorkspaceFocused ||
      hasVisibleOverlay({ ignoreMatches: '[role="listbox"], [role="menu"]' })
    ) {
      return false
    }
    const worktrees = resolveWorkspaceSleepShortcutTargets(
      store,
      getPublishedSidebarSelection(),
      getHoveredWorkspaceIdentity()
    )
    // Nothing to sleep: let the chord fall through.
    if (worktrees.length === 0) {
      return false
    }
    return claim(() =>
      requestWorkspaceSleep({
        state: store,
        openModal: store.openModal,
        worktrees,
        sleep: (worktreeIds) => void runSleepWorktrees(worktreeIds)
      })
    )
  }
}
