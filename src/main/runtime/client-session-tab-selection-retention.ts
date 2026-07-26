import type { ClientSessionTabSelection } from './client-session-tab-selection'
import {
  isMobileTabSelectionIdRetainable,
  MOBILE_TAB_SELECTION_MAX_BYTES_PER_CLIENT,
  MOBILE_TAB_SELECTION_MAX_CLIENTS,
  MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT,
  mobileTabSelectionRetainedBytes
} from './client-session-tab-selection-persistence'

export type StoredClientSessionTabSelection = {
  selection: ClientSessionTabSelection
  revision: number
  shouldPersist: boolean
}

export function getOrCreateClientTabSelectionWorktrees(
  statesByClient: Map<string, Map<string, StoredClientSessionTabSelection>>,
  clientNavigationId: string
): Map<string, StoredClientSessionTabSelection> {
  let statesByWorktree = statesByClient.get(clientNavigationId)
  if (!statesByWorktree) {
    if (statesByClient.size >= MOBILE_TAB_SELECTION_MAX_CLIENTS) {
      const oldestClientId = statesByClient.keys().next().value
      if (oldestClientId !== undefined) {
        statesByClient.delete(oldestClientId)
      }
    }
    statesByWorktree = new Map()
    statesByClient.set(clientNavigationId, statesByWorktree)
  }
  return statesByWorktree
}

export function rememberClientTabSelectionWorktree(
  statesByWorktree: Map<string, StoredClientSessionTabSelection>,
  worktreeId: string,
  state: StoredClientSessionTabSelection
): void {
  if (!isMobileTabSelectionIdRetainable(worktreeId)) {
    return
  }
  if (
    !statesByWorktree.has(worktreeId) &&
    statesByWorktree.size >= MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT
  ) {
    const oldestWorktreeId = statesByWorktree.keys().next().value
    if (oldestWorktreeId !== undefined) {
      statesByWorktree.delete(oldestWorktreeId)
    }
  }
  statesByWorktree.set(worktreeId, state)
  let retainedBytes = 0
  for (const [retainedWorktreeId, retainedState] of statesByWorktree) {
    retainedBytes += mobileTabSelectionRetainedBytes(retainedWorktreeId, retainedState.selection)
  }
  while (retainedBytes > MOBILE_TAB_SELECTION_MAX_BYTES_PER_CLIENT) {
    const oldest = statesByWorktree.entries().next()
    if (oldest.done) {
      break
    }
    statesByWorktree.delete(oldest.value[0])
    retainedBytes -= mobileTabSelectionRetainedBytes(oldest.value[0], oldest.value[1].selection)
  }
}
