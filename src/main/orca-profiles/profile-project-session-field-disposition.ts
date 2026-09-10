import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** What `removeRepoFromWorkspaceSession` does with a field when its repo goes away. */
export type SessionFieldRepoRemovalDisposition =
  /** Owner-keyed map: the shared helper deletes every key belonging to the repo. */
  | 'prunedByOwnerKey'
  /** Pruned too, but by a rule of its own -- derived ids, pane keys, or a scalar. */
  | 'prunedByBespokeRule'
  /**
   * This path leaves it alone. That is not the same as holding nothing repo-scoped: some of these
   * are pruned by the owner-scanning pass instead, and some are known residue. The entries below
   * say which, because the label alone would read as a clean bill of health.
   */
  | 'notRepoScoped'

/** What `extractSessionForTransfer` does with a field when its repo moves to another profile. */
export type SessionFieldTransferDisposition =
  /** Owner-keyed map: keys are rekeyed onto the new repo id and the values cloned as-is. */
  | 'copiedByOwnerKey'
  /** Copied too, but with element-level rekeying or an id filter of its own. */
  | 'copiedByBespokeRule'
  /** Deliberately left behind: it names something only the source profile can resolve. */
  | 'notTransferred'

type SessionFieldDisposition = {
  onRepoRemoval: SessionFieldRepoRemovalDisposition
  onTransfer: SessionFieldTransferDisposition
}

/**
 * Every persisted session field, and what the repo-removal and project-transfer paths owe it.
 *
 * Why this exists: `clientHostedBrowserPagesByWorktree` was added to the session type and then
 * missed by three separate prune paths, because nothing made handling it mandatory. Classification
 * is now a compile error to skip, and the two owner-keyed lists below are what those paths
 * actually iterate -- so a field marked `prunedByOwnerKey` is pruned by construction.
 *
 * Not covered: `mergeWorkspaceSessions`, the apply side of a transfer, is still a hand-written
 * field list. It is safe for this field only because `extractSessionForTransfer` never emits it --
 * classify a new field as transferable and that merge has to be edited by hand.
 */
export const WORKSPACE_SESSION_FIELD_DISPOSITION = {
  // Residue: it can name the repo being removed, and no main-side path clears it. Harmless only
  // because every renderer read resolves it against the live repo list, so a dead id reads as none.
  activeRepoId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeWorkspaceKey: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  activeWorkspaceExecutionHostId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeWorktreeId: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  // Residue here specifically: the owner-removal path nulls this when it deletes the tab it names,
  // but repo removal does not, so it can outlive the tab.
  activeTabId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  tabsByWorktree: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  // Keyed by tab id, so both paths follow the tab ids the terminal maps gave up or carried over.
  terminalLayoutsByTabId: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  activeWorktreeIdsOnShutdown: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  openFilesByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByBespokeRule' },
  activeFileIdByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  markdownFrontmatterVisible: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  browserTabsByWorktree: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Keyed by browser workspace id, so both paths follow the workspaces the map above resolved.
  browserPagesByWorkspace: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  activeBrowserTabIdByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  // Why not transferred: each row names a paired device and a browser profile that only the source
  // profile can resolve, and the payload carries neither -- the same reason a transferred browser
  // workspace gives up its sessionProfileId. A copied row would restore as a held tab no device can
  // ever reclaim, which is exactly the stuck "unavailable" state persistence exists to prevent.
  clientHostedBrowserPagesByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'notTransferred'
  },
  // Keyed by runtime environment, not by worktree: this client's debt to environments that outlive
  // any one repo.
  clientHostedBrowserCloseIntentsByEnvironment: {
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
  // Residue: keyed by tab id and pruned by neither path, so entries for a removed repo's tabs stay.
  remoteSessionIdsByTabId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  lastVisitedAtByWorktreeId: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  defaultTerminalTabsAppliedByWorktreeId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  // Owner-scoped after all, just not by this path: deleteScannedSessionFieldsForOwners prunes it by
  // the record's worktreeId on worktree and project removal. Moving a project between profiles runs
  // removeSourceRepo, which has no owner scan, so these records leak there.
  sleepingAgentSessionsByPaneKey: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  terminalPtyIncarnationsByPaneKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Repo-keyed rather than worktree-keyed, but the owner-key helpers already treat a bare repo id
  // as its own owner key.
  terminalTopologyRevisionByRepoId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  terminalSurfaceTombstonesByPaneKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Residue: keyed by tab id and pruned by neither path, like remoteSessionIdsByTabId. Bounded
  // anyway -- every write and every pull merge runs it through the TTL and cap in
  // shared/closed-terminal-tab-tombstones.ts, and a resolved host retires its own entries.
  closedTerminalTabTombstonesByTabId: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred'
  }
} as const satisfies Record<keyof WorkspaceSessionState, SessionFieldDisposition>

// Why: an unclassified field is a field both paths forget, and the leak only surfaces as state
// belonging to a project that is no longer here.
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
