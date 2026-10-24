import { resolveWorktreeLineageParents } from '../../shared/resolved-worktree-lineage'
import { readWorktreeLineageCorpus, type LineageStore } from '../worktree-lineage-candidates'
import { getWorktreeHostIdentity } from '../../shared/worktree/host-qualified-identity'
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
  > &
    LineageStore & { getSettings: () => { notifications?: NotificationSettings } }
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
  const snapshot = readWorktreeLineageCorpus(deps.store)
  const rows = new Map<string, Worktree>(
    snapshot.rows.map((row) => [getWorktreeHostIdentity(row), row])
  )
  const listedByIdentity = new Map<string, Worktree>(
    (deps.resolvedWorktrees ?? []).map((row) => {
      const current = snapshot.currentRow(row)
      return [getWorktreeHostIdentity(current), current]
    })
  )
  for (const [key, row] of listedByIdentity) {
    rows.set(key, row)
  }
  const children = new Map<string, string[]>()
  for (const [child, parent] of resolveWorktreeLineageParents(
    [...rows.values()],
    snapshot.edgeOf
  )) {
    const key = getWorktreeHostIdentity(parent)
    const siblings = children.get(key) ?? []
    siblings.push(getWorktreeHostIdentity(child))
    children.set(key, siblings)
  }
  const isRowHidden = (key: string): boolean => {
    const row = rows.get(key)
    const id = row?.id ?? key
    const listed = listedByIdentity.get(key)
    const meta = row ?? deps.store.getWorktreeMeta(id)
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
  const isShown = (key: string): boolean => {
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return !isRowHidden(key) || (children.get(key) ?? []).some(isShown)
  }
  const targets = [...rows].filter(([, row]) => row.id === workspaceId)
  return targets.length > 0 ? targets.every(([key]) => !isShown(key)) : isRowHidden(workspaceId)
}
