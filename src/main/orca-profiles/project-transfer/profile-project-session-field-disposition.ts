import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'

export type SessionFieldRepoRemovalDisposition =
  /** Delete map keys belonging to the repo. */
  | 'prunedByOwnerKey'
  /** Prune by derived IDs, pane keys or scalar rules. */
  | 'prunedByBespokeRule'
  /** Untouched here; entries below distinguish other pruning paths from known residue. */
  | 'notRepoScoped'

export type SessionFieldTransferDisposition =
  /** Rekey to the destination repo and clone values. */
  | 'copiedByOwnerKey'
  /** Copy with element-level rekeying or filtering. */
  | 'copiedByBespokeRule'
  /** Source-profile-only entities cannot transfer. */
  | 'notTransferred'

export type SessionFieldWorkspaceRemovalDisposition =
  /** Delete the removed workspace's key. */
  | 'ownerKey'
  /** Delete entries keyed by the removed workspace's terminal tab IDs. */
  | 'ownerTabKey'
  /** Delete `tabId:leafId` entries of the removed workspace's terminal tabs. */
  | 'ownerPaneKey'
  /** Delete entries whose record names the removed workspace. */
  | 'ownerRow'
  /** Removed by a rule in removeWorkspaceSessionOwners. */
  | 'bespoke'
  /** Not workspace-scoped. */
  | 'kept'

type SessionFieldDisposition = {
  onRepoRemoval: SessionFieldRepoRemovalDisposition
  onTransfer: SessionFieldTransferDisposition
  onWorkspaceRemoval: SessionFieldWorkspaceRemovalDisposition
}

/** Classify every persisted field so owner-keyed pruning/transfer cannot omit additions.
 * Transferable additions still require manual updates to mergeWorkspaceSessions. */
export const WORKSPACE_SESSION_FIELD_DISPOSITION = {
  // Residue: renderer reads validate this ID against live repos, so dead IDs resolve to none.
  activeRepoId: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'kept'
  },
  activeWorkspaceKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'bespoke'
  },
  activeWorkspaceExecutionHostId: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'kept'
  },
  activeWorktreeId: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'bespoke'
  },
  // Owner removal clears this when its tab dies; repo removal can leave it stale.
  activeTabId: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'bespoke'
  },
  tabsByWorktree: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'bespoke'
  },
  // Follow tab IDs removed or carried by terminal maps.
  terminalLayoutsByTabId: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'ownerTabKey'
  },
  localOnlyScrollbackByTabId: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'ownerTabKey'
  },
  activeWorktreeIdsOnShutdown: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'bespoke'
  },
  openFilesByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'ownerKey'
  },
  activeFileIdByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey',
    onWorkspaceRemoval: 'ownerKey'
  },
  markdownFrontmatterVisible: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'bespoke'
  },
  browserTabsByWorktree: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'bespoke'
  },
  // Follow browser workspace IDs resolved above.
  browserPagesByWorkspace: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'bespoke'
  },
  activeBrowserTabIdByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey',
    onWorkspaceRemoval: 'ownerKey'
  },
  // Paired devices/browser profiles are source-scoped; copying rows would strand unavailable tabs.
  clientHostedBrowserPagesByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'ownerKey'
  },
  // Environment cleanup debt outlives individual repos.
  clientHostedBrowserCloseIntentsByEnvironment: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'kept'
  },
  pairedTerminalTabCloseIntentsByEnvironment: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'kept'
  },
  activeTabTypeByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey',
    onWorkspaceRemoval: 'ownerKey'
  },
  browserUrlHistory: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'kept'
  },
  workspaceDocHistory: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'kept'
  },
  activeTabIdByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey',
    onWorkspaceRemoval: 'ownerKey'
  },
  unifiedTabs: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'ownerKey'
  },
  tabGroups: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'ownerKey'
  },
  tabGroupLayouts: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey',
    onWorkspaceRemoval: 'ownerKey'
  },
  activeGroupIdByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey',
    onWorkspaceRemoval: 'ownerKey'
  },
  activeConnectionIdsAtShutdown: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'kept'
  },
  // Residue: neither path prunes removed tabs’ remote session IDs.
  remoteSessionIdsByTabId: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'ownerTabKey'
  },
  desktopRelayOwnerByTabId: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'ownerTabKey'
  },
  desktopRelayAdoptionVersion: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'kept'
  },
  lastVisitedAtByWorktreeId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey',
    onWorkspaceRemoval: 'bespoke'
  },
  defaultTerminalTabsAppliedByWorktreeId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey',
    onWorkspaceRemoval: 'ownerKey'
  },
  // Owner scans prune by worktreeId, but cross-profile source removal has no scan and leaves residue.
  sleepingAgentSessionsByPaneKey: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'ownerRow'
  },
  terminalPtyIncarnationsByPaneKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'ownerPaneKey'
  },
  // Owner-key helpers also accept bare repo IDs.
  terminalTopologyRevisionByRepoId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey',
    onWorkspaceRemoval: 'bespoke'
  },
  terminalSurfaceTombstonesByPaneKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule',
    onWorkspaceRemoval: 'ownerRow'
  },
  // Pruned by worktreeId during owner removal; transferred source residue clears on next profile load.
  closedTerminalTabTombstonesByTabId: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'ownerRow'
  },
  // Owner removal prunes by worktreeId; closed panes do not transfer.
  closedTerminalPanesByPaneKey: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred',
    onWorkspaceRemoval: 'ownerRow'
  }
} as const satisfies Record<keyof WorkspaceSessionState, SessionFieldDisposition>

// Missing classifications would leak state belonging to removed projects.
type UnclassifiedSessionField = Exclude<
  keyof WorkspaceSessionState,
  keyof typeof WORKSPACE_SESSION_FIELD_DISPOSITION
>
const exhaustive: [UnclassifiedSessionField] extends [never] ? true : never = true
void exhaustive

const SESSION_FIELDS = Object.keys(
  WORKSPACE_SESSION_FIELD_DISPOSITION
) as (keyof WorkspaceSessionState)[]

export const SESSION_FIELDS_PRUNED_BY_OWNER_KEY = SESSION_FIELDS.filter(
  (field) => WORKSPACE_SESSION_FIELD_DISPOSITION[field].onRepoRemoval === 'prunedByOwnerKey'
)

export const SESSION_FIELDS_COPIED_BY_OWNER_KEY = SESSION_FIELDS.filter(
  (field) => WORKSPACE_SESSION_FIELD_DISPOSITION[field].onTransfer === 'copiedByOwnerKey'
)

export function sessionFieldsRemovedWithWorkspace(
  disposition: SessionFieldWorkspaceRemovalDisposition
): (keyof WorkspaceSessionState)[] {
  return SESSION_FIELDS.filter(
    (field) => WORKSPACE_SESSION_FIELD_DISPOSITION[field].onWorkspaceRemoval === disposition
  )
}
