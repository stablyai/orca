// Apply this host's persisted sidebar filters to phone pushes, never the shared unread dot or paired-client settings.
// Main lacks renderer tab state, so sleeping stays renderer-owned; host-local rows need no paired-device ownership map.
// Missing UI/workspace state and hidden parents with shown lineage children fail open.
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { Worktree } from '../../shared/worktree/types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  isHiddenByWorkspaceKindSwitch,
  type WorkspaceKindSwitches
} from '../../shared/worktree/workspace-kinds'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  isWorkspaceOwnedBySomeoneElse
} from '../../shared/workspace-creator-visibility'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import type { RuntimeStore } from './runtime-store-contract'

export type WorkspaceNotificationMuteDeps = {
  store: Pick<
    RuntimeStore,
    'getUI' | 'getRepo' | 'getWorktreeMeta' | 'getAllWorktreeLineage' | 'getFolderWorkspaces'
  > & { getSettings: () => { notifications?: NotificationSettings } }
  /** Last resolved Git listing, possibly stale; branch and HEAD come only from here. */
  resolvedWorktrees: readonly Worktree[] | null
}

/** `workspaceId` is the sidebar's id: a worktree id, or `folder:<id>` for a folder workspace. */
export function isWorkspaceNotificationMuted(
  deps: WorkspaceNotificationMuteDeps,
  workspaceId: string
): boolean {
  return (
    deps.store.getSettings().notifications?.notifyHiddenWorkspaces === false &&
    isWorkspaceHiddenBySidebarFilters(deps, workspaceId)
  )
}

export function isWorkspaceHiddenBySidebarFilters(
  deps: WorkspaceNotificationMuteDeps,
  workspaceId: string
): boolean {
  const ui = deps.store.getUI?.()
  if (!ui) {
    return false
  }
  const hideOtherClients = ui.hideWorkspacesFromOtherDevices === true
  const switches: WorkspaceKindSwitches = {
    hideDefaultBranchWorkspace: ui.hideDefaultBranchWorkspace === true,
    hideAutomationGeneratedWorkspaces: ui.hideAutomationGeneratedWorkspaces === true,
    hideCliCreatedWorkspaces: ui.hideCliCreatedWorkspaces === true,
    hideDetachedHeadWorkspaces: ui.hideDetachedHeadWorkspaces === true
  }
  if (!hideOtherClients && !Object.values(switches).some(Boolean)) {
    return false
  }
  const folderScope = parseWorkspaceKey(workspaceId)
  if (folderScope?.type === 'folder') {
    // Folder rows answer only the other-client switch, as in the sidebar.
    const folder = deps.store
      .getFolderWorkspaces?.()
      .find((item) => item.id === folderScope.folderWorkspaceId)
    return (
      hideOtherClients &&
      folder !== undefined &&
      isWorkspaceOwnedBySomeoneElse(folder, EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT)
    )
  }
  const lineage = Object.values(deps.store.getAllWorktreeLineage?.() ?? {})
  const isRowHidden = (id: string): boolean => {
    const listed = deps.resolvedWorktrees?.find((worktree) => worktree.id === id)
    const meta = deps.store.getWorktreeMeta(id)
    if (!listed && !meta) {
      return false
    }
    if (
      hideOtherClients &&
      isWorkspaceOwnedBySomeoneElse(
        { creatorProvenance: listed?.creatorProvenance ?? meta?.creatorProvenance },
        EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT
      )
    ) {
      return true
    }
    // Without a Git listing, only provenance filters can apply; branch and HEAD are unknown.
    const kind = listed ?? {
      isMainWorktree: false,
      branch: '',
      head: '',
      automationProvenance: meta?.automationProvenance,
      cliProvenance: meta?.cliProvenance
    }
    return isHiddenByWorkspaceKindSwitch(
      kind,
      deps.store.getRepo(getRepoIdFromWorktreeId(id)),
      switches
    )
  }
  const seen = new Set<string>()
  const isShown = (id: string): boolean => {
    if (seen.has(id)) {
      return false
    }
    seen.add(id)
    return (
      !isRowHidden(id) ||
      lineage.some((entry) => entry.parentWorktreeId === id && isShown(entry.worktreeId))
    )
  }
  return !isShown(workspaceId)
}
