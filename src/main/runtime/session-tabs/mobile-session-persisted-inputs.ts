import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import type { RuntimeWorkspaceSessionController } from '../workspaces/session-hosts/runtime-workspace-session-controller'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import {
  borrowWorkspaceSession,
  isOwnedWorkspaceSession
} from '../../persistence/loading-store/workspace-sessions/session-host-partitions'
import type { RuntimeMobileSessionTerminalTab } from '../../../shared/runtime-mobile-session-tab-contracts'

/** Runtime snapshots outlive their projection; owned saved values must not escape into them. */
export function detachMobileSessionTerminalValues(
  tabs: RuntimeMobileSessionTerminalTab[],
  owned: boolean
): RuntimeMobileSessionTerminalTab[] {
  return owned
    ? tabs.map((tab) => ({
        ...tab,
        ...(tab.aiVaultTitle ? { aiVaultTitle: structuredClone(tab.aiVaultTitle) } : {}),
        ...(tab.parentLayout
          ? { parentLayout: { ...tab.parentLayout, root: structuredClone(tab.parentLayout.root) } }
          : {})
      }))
    : tabs
}

export function isOwnedMobileSessionSource(
  sessions: RuntimeWorkspaceSessionController,
  store: RuntimeStore | null,
  worktreeId: string | undefined,
  session: WorkspaceSessionState
): boolean {
  return worktreeId
    ? sessions.isOwned(worktreeId) && session === sessions.borrow(worktreeId)
    : isOwnedWorkspaceSession(store) && session === borrowWorkspaceSession(store)
}

export function savedMobileSessionNavigation(
  session: WorkspaceSessionState,
  worktreeId: string,
  owned: boolean
) {
  const groups = session.tabGroups?.[worktreeId]
  const layout = session.tabGroupLayouts?.[worktreeId]
  return {
    groups: owned ? structuredClone(groups) : groups,
    layout: owned ? structuredClone(layout) : layout
  }
}

/** Removed repositories must not reappear as phantom workspaces during hydration. */
export function registeredSessionWorkspaces<T>(
  entries: readonly (readonly [string, T])[],
  store: RuntimeStore | null
): readonly (readonly [string, T])[] {
  let liveRepoIds: Set<string> | null | undefined
  return entries.filter(([worktreeId]) => {
    const repoId = splitWorktreeIdForFilesystem(worktreeId)?.repoId
    if (!repoId) {
      return true
    }
    if (liveRepoIds === undefined) {
      const repos = store?.getRepos?.()
      liveRepoIds = repos ? new Set(repos.map((repo) => repo.id)) : null
    }
    return !liveRepoIds || liveRepoIds.has(repoId)
  })
}
