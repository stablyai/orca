// The host's read of "Notify About Hidden Workspaces": with it off, news from a workspace the
// desktop's sidebar Filters switches hide sends no phone push from the host. The shared unread dot
// ignores it: clients' Filters differ.
// The setting and the switches are this host's own persisted state; a paired client's never apply.
//
// WHY NOT "HIDE SLEEPING": main sees the persisted switches and its in-memory workspace records,
// not the renderer's live tabs, so sleeping is left to the renderer; a workspace with news is live
// anyway. Rows here are this host's own (no runtime owner environment), so the shared other-client
// rule needs no paired-device map; this host's own phones record it as creator.
//
// FAILS OPEN: no persisted UI, no record of the workspace, or a hidden parent with a shown lineage
// child (the sidebar keeps it above that child) all notify.
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
    // Without a Git listing, no branch or HEAD is known, so only the provenance switches can apply.
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
