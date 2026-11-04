import { useAppStore } from '@/store'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import {
  hasSidebarGroupCollapseScope,
  toggleSidebarGroupsCollapse
} from '@/lib/sidebar-group-collapse'
import type { KeybindingActionId } from '../../../shared/keybindings'

export function createSidebarGroupsCollapseCommand(
  claim: (actionId: KeybindingActionId, run: () => void) => boolean,
  creationLayoutActive: boolean,
  floatingWorkspaceFocused: boolean
): () => boolean {
  return () => {
    if (
      useAppStore.getState().activeModal !== 'none' ||
      creationLayoutActive ||
      floatingWorkspaceFocused ||
      hasVisibleOverlay({ ignoreMatches: '[role="listbox"], [role="menu"]' }) ||
      !hasSidebarGroupCollapseScope()
    ) {
      return false
    }
    return claim('sidebar.groups.toggleCollapseAll', toggleSidebarGroupsCollapse)
  }
}
