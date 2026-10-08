import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { assertHostEditorAuthority, type EditorAuthorityHost } from './editor-authority'
import {
  buildHostEditorMobileTabs,
  overlayHostEditorTabs,
  type HostEditorMobileTab
} from './host-editor-tab-projection'
import {
  getHostEditorTabState,
  type HostDiffTabRecord,
  type HostEditorTabStateOwner
} from './host-editor-tab-state'

/** The runtime members host editor tabs need; the runtime mixins satisfy this structurally. */
export type HostEditorTabsRuntime = EditorAuthorityHost & {
  getOwnWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null
  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId?: string): Set<string>
  /** The workspace root rows are joined onto, or null when it cannot be known synchronously. */
  getHostEditorWorkspaceRoot(worktreeId: string): string | null
  readonly mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot
  emitMobileSessionTabsSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void
  getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult
  applyMobileSessionTabNavigation(
    snapshot: RuntimeMobileSessionTabsResult,
    activeTabId: string,
    navigation: RuntimeNavigationTarget,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult
}

export function requireOwnSession(
  runtime: HostEditorTabsRuntime,
  worktreeId: string
): WorkspaceSessionState {
  const session = runtime.getOwnWorkspaceSessionForWorktree(worktreeId)
  if (!session) {
    throw new Error('workspace_session_unavailable')
  }
  return session
}

export function commitHostEditorSession(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  session: WorkspaceSessionState
): void {
  assertHostEditorAuthority(runtime)
  runtime.setWorkspaceSessionForWorktree(worktreeId, session)
}

/** Re-derives the worktree's snapshot from the session and publishes it before a reply returns. */
export function publishHostEditorTabs(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  focusTabId?: string
): void {
  runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
  let snapshot = runtime.mobileSessionTabsByWorktree.get(worktreeId)
  if (snapshot && focusTabId && snapshot.activeTabId !== focusTabId) {
    const session = runtime.getWorkspaceSessionForWorktree(worktreeId)
    snapshot = runtime.storeMobileSessionSnapshot(worktreeId, {
      ...overlayHostEditorTabs(
        snapshot,
        listHostEditorMobileTabs(runtime, worktreeId, session),
        session,
        { tabId: focusTabId }
      ),
      snapshotVersion: snapshot.snapshotVersion + 1
    })
  }
  if (snapshot) {
    runtime.emitMobileSessionTabsSnapshot(snapshot)
  }
}

export function findHostDiffTab(
  runtime: HostEditorTabStateOwner,
  worktreeId: string,
  tabId: string
): HostDiffTabRecord | undefined {
  return getHostEditorTabState(runtime)
    .listDiffs(worktreeId)
    .find((diff) => diff.tabId === tabId)
}

/** The host's editor tabs for one worktree, or none while a window owns editors. */
export function listHostEditorMobileTabs(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  session: WorkspaceSessionState | null
): HostEditorMobileTab[] {
  return buildHostEditorMobileTabs(
    session,
    worktreeId,
    getHostEditorTabState(runtime).listDiffs(worktreeId),
    runtime.getHostEditorWorkspaceRoot(worktreeId)
  )
}

export function overlayHostEditorTabsOnSnapshot(
  runtime: HostEditorTabsRuntime,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  session: WorkspaceSessionState | null
): RuntimeMobileSessionTabsSnapshot {
  return overlayHostEditorTabs(
    snapshot,
    listHostEditorMobileTabs(runtime, snapshot.worktree, session),
    session
  )
}
