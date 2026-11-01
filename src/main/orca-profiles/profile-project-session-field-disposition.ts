import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

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

type SessionFieldDisposition = {
  onRepoRemoval: SessionFieldRepoRemovalDisposition
  onTransfer: SessionFieldTransferDisposition
}

/** Classify every persisted field so owner-keyed pruning/transfer cannot omit additions.
 * Transferable additions still require manual updates to mergeWorkspaceSessions. */
export const WORKSPACE_SESSION_FIELD_DISPOSITION = {
  // Residue: renderer reads validate this ID against live repos, so dead IDs resolve to none.
  activeRepoId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeWorkspaceKey: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  activeWorkspaceExecutionHostId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeWorktreeId: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  // Owner removal clears this when its tab dies; repo removal can leave it stale.
  activeTabId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  tabsByWorktree: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  // Follow tab IDs removed or carried by terminal maps.
  terminalLayoutsByTabId: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  localOnlyScrollbackByTabId: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  activeWorktreeIdsOnShutdown: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  openFilesByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByBespokeRule' },
  activeFileIdByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  markdownFrontmatterVisible: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  browserTabsByWorktree: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Follow browser workspace IDs resolved above.
  browserPagesByWorkspace: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  activeBrowserTabIdByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  // Paired devices/browser profiles are source-scoped; copying rows would strand unavailable tabs.
  clientHostedBrowserPagesByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'notTransferred'
  },
  // Environment cleanup debt outlives individual repos.
  clientHostedBrowserCloseIntentsByEnvironment: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred'
  },
  pairedTerminalTabCloseIntentsByEnvironment: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred'
  },
  activeTabTypeByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  browserUrlHistory: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  workspaceDocHistory: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeTabIdByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  unifiedTabs: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByBespokeRule' },
  tabGroups: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByBespokeRule' },
  tabGroupLayouts: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  activeGroupIdByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  activeConnectionIdsAtShutdown: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  // Residue: neither path prunes removed tabs’ remote session IDs.
  remoteSessionIdsByTabId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  lastVisitedAtByWorktreeId: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  defaultTerminalTabsAppliedByWorktreeId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  // Owner scans prune by worktreeId, but cross-profile source removal has no scan and leaves residue.
  sleepingAgentSessionsByPaneKey: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  terminalPtyIncarnationsByPaneKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Owner-key helpers also accept bare repo IDs.
  terminalTopologyRevisionByRepoId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  terminalSurfaceTombstonesByPaneKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Pruned by worktreeId during owner removal; transferred source residue clears on next profile load.
  closedTerminalTabTombstonesByTabId: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred'
  },
  // Owner removal prunes by worktreeId; closed panes do not transfer.
  closedTerminalPanesByPaneKey: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred'
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
