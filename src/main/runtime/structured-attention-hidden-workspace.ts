// Whether the desktop's sidebar Filters switches hide a workspace, for this host's own phone push
// of structured-chat attention (the caller applies "Notify About Hidden Workspaces").
//
// WHY NOT "HIDE SLEEPING": main sees the persisted switches and its in-memory workspace records,
// not the renderer's live tabs, so sleeping is left to the renderer; a local chat that raises
// attention is live anyway. Rows here are this host's own (no runtime owner environment), so the
// shared other-client rule needs no paired-device map; this host's own phones record it as creator.
//
// FAILS OPEN: no persisted UI, no record of the workspace, or a hidden parent with a shown lineage
// child (the sidebar keeps it above that child) all notify.
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { Worktree } from '../../shared/worktree/types'
import {
  isHiddenByWorkspaceKindSwitch,
  type WorkspaceKindSwitches
} from '../../shared/worktree/workspace-kinds'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  isWorkspaceOwnedBySomeoneElse
} from '../../shared/workspace-creator-visibility'
import type { RuntimeStore } from './runtime-store-contract'

export type HiddenWorkspaceAttentionDeps = {
  store: Pick<
    RuntimeStore,
    'getUI' | 'getRepo' | 'getWorktreeMeta' | 'getAllWorktreeLineage' | 'getFolderWorkspaces'
  >
  /** Last resolved Git listing, possibly stale; branch and HEAD come only from here. */
  resolvedWorktrees: readonly Worktree[] | null
}

export function isStructuredAttentionWorkspaceHidden(
  deps: HiddenWorkspaceAttentionDeps,
  scope: AgentSessionExecutionLocation
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
  const workspaceId = scope.workspaceId
  if (scope.workspaceKind === 'folder') {
    // Folder rows answer only the other-client switch, as in the sidebar.
    const folder = deps.store.getFolderWorkspaces?.().find((item) => item.id === workspaceId)
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
