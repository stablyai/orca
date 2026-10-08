import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { resolveEditorAuthority } from './editor-authority'
import { persistHostTabGroupLayout } from './host-editor-session-layout'
import { isUnifiedWorkspaceSession } from './host-editor-session-model'
import { editPersistedTabGroups, type SnapshotTabIdTranslation } from './host-editor-tab-group-edit'
import { translateHostSnapshotTabIds } from './host-editor-tab-group-placement'
import {
  commitHostEditorSession,
  listHostEditorMobileTabs,
  type HostEditorTabsRuntime
} from './host-editor-tab-publication'
import { getHostEditorTabState } from './host-editor-tab-state'

function hasEditorTabs(snapshot: RuntimeMobileSessionTabsSnapshot): boolean {
  return snapshot.tabs.some((tab) => tab.type === 'markdown' || tab.type === 'file')
}

/**
 * Whether a headless move in this worktree edits the unified session's persisted groups, in which
 * case the snapshot's groups (only what the host can show) must not be written as the whole model.
 */
export function hostEditsPersistedTabGroups(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  snapshot: RuntimeMobileSessionTabsSnapshot
): boolean {
  return editedPersistedSession(runtime, worktreeId, snapshot) !== null
}

function editedPersistedSession(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  snapshot: RuntimeMobileSessionTabsSnapshot
): WorkspaceSessionState | null {
  if (resolveEditorAuthority(runtime) !== 'host' || !hasEditorTabs(snapshot)) {
    return null
  }
  const session = runtime.getOwnWorkspaceSessionForWorktree(worktreeId)
  return session &&
    isUnifiedWorkspaceSession(session) &&
    (session.tabGroups?.[worktreeId]?.length ?? 0) > 0
    ? session
    : null
}

function translateSessionSnapshotTabIds(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  session: WorkspaceSessionState,
  snapshot: RuntimeMobileSessionTabsSnapshot
): SnapshotTabIdTranslation {
  return translateHostSnapshotTabIds(
    snapshot.tabs,
    listHostEditorMobileTabs(runtime, worktreeId, session),
    session.unifiedTabs?.[worktreeId] ?? []
  )
}

/**
 * Whether splitting this tab off would leave a group holding only a tab nothing persists (a diff, an
 * unwrapped chat). The persisted groups cannot keep that group, so the split would snap back.
 */
export function hostRefusesSplitOfTransientTab(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  hostTabId: string
): boolean {
  const session = editedPersistedSession(runtime, worktreeId, snapshot)
  return (
    session !== null &&
    translateSessionSnapshotTabIds(runtime, worktreeId, session, snapshot).toWrapperId(
      hostTabId
    ) === null
  )
}

/** After a headless move/split/reorder, persists groups plus editor placement in one write. */
export function persistHostEditorLayout(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  snapshot: RuntimeMobileSessionTabsSnapshot
): void {
  if (!hasEditorTabs(snapshot)) {
    return
  }
  const groupIdByTabId = new Map<string, string>()
  for (const group of snapshot.tabGroups ?? []) {
    for (const tabId of group.tabOrder) {
      groupIdByTabId.set(tabId, group.id)
    }
  }
  const state = getHostEditorTabState(runtime)
  state.setDiffGroups(worktreeId, groupIdByTabId)
  const session = runtime.getOwnWorkspaceSessionForWorktree(worktreeId)
  if (!session) {
    return
  }
  const next = isUnifiedWorkspaceSession(session)
    ? editPersistedTabGroups(
        session,
        worktreeId,
        snapshot,
        translateSessionSnapshotTabIds(runtime, worktreeId, session, snapshot)
      )
    : persistHostTabGroupLayout(session, worktreeId, {
        groups: snapshot.tabGroups ?? [],
        groupLayout: snapshot.tabGroupLayout,
        activeGroupId: snapshot.activeGroupId,
        transientTabIds: new Set(state.listDiffs(worktreeId).map((diff) => diff.tabId))
      })
  if (next) {
    commitHostEditorSession(runtime, worktreeId, next)
  }
}
