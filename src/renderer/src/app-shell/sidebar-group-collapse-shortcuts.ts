import { requestVirtualizedScrollAnchorRecord } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import {
  getRenderedLineageChipKeys,
  resolveChildWorkspacesToggleGroupKey
} from '../components/sidebar/workspace-card/identity/child-workspaces-toggle-target'
import { resolveProjectCollapseAllToggleKeys } from '../components/sidebar/worktree-list/listing/project-collapse-all-target'
import { useAppStore } from '../store'

type AppStoreState = ReturnType<typeof useAppStore.getState>
type ClaimShortcut = (run: () => void) => boolean

function sidebarCollapseShortcutYields(
  store: AppStoreState,
  floatingWorkspaceFocused: boolean
): boolean {
  // Locally controlled dialogs do not set activeModal.
  return (
    store.activeModal !== 'none' ||
    floatingWorkspaceFocused ||
    hasVisibleOverlay({ ignoreMatches: '[role="listbox"], [role="menu"]' })
  )
}

function toggleSidebarGroups(store: AppStoreState, groupKeys: readonly string[]): void {
  const expanding = groupKeys.some((groupKey) => store.collapsedGroups.has(groupKey))
  // Match chip-click scroll anchoring to avoid viewport jumps.
  requestVirtualizedScrollAnchorRecord('[data-worktree-sidebar]')
  // The chevron's own action, so persistence matches a click on each header.
  for (const groupKey of groupKeys) {
    store.toggleCollapsedGroup(groupKey)
  }
  if (expanding) {
    store.setSidebarOpen(true)
  }
}

export function createChildWorkspacesShortcutHandler(
  floatingWorkspaceFocused: boolean,
  claim: ClaimShortcut
): () => boolean {
  return () => {
    const store = useAppStore.getState()
    if (sidebarCollapseShortcutYields(store, floatingWorkspaceFocused)) {
      return false
    }
    const groupKey = resolveChildWorkspacesToggleGroupKey(store, getRenderedLineageChipKeys(store))
    return groupKey ? claim(() => toggleSidebarGroups(store, [groupKey])) : false
  }
}

export function createProjectCollapseAllShortcutHandler(
  floatingWorkspaceFocused: boolean,
  claim: ClaimShortcut
): () => boolean {
  return () => {
    const store = useAppStore.getState()
    if (sidebarCollapseShortcutYields(store, floatingWorkspaceFocused)) {
      return false
    }
    const groupKeys = resolveProjectCollapseAllToggleKeys(store)
    return groupKeys.length > 0 ? claim(() => toggleSidebarGroups(store, groupKeys)) : false
  }
}
