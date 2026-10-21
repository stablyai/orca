import { isWorkspaceKey } from '../../../shared/workspace-scope'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import {
  orcadMigrationOwnerMatchesScope,
  orcadMigrationOwnsRepoId,
  unqualifyOrcadMigrationOwnerKey,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'
import {
  paneBelongsToTabs,
  paneBelongsToTerminalLayout
} from '../../../shared/workspace-session-pane-ownership'

/**
 * What on the source the move must not drop or cannot carry, each named for the refusal with the
 * way out. Stale or unowned rows are not here: they stay in the retained profile.
 */
export function collectUnsupportedSessionItems(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  sourceHostPartition: boolean,
  terminalTabIds: ReadonlySet<string>,
  /** Every partition's source terminal tabs: a record is orphaned only when none lists its tab. */
  sourceTerminalTabIds: ReadonlySet<string>
): string[] {
  const owns = (ownerKey: string): boolean => orcadMigrationOwnerMatchesScope(ownerKey, scope)
  const matches = (ownerKey: string): boolean =>
    Boolean(ownerKey) && (sourceHostPartition || owns(ownerKey))
  const items: string[] = []
  // Another project's rows in this host's copy stay behind; only an unsaved draft there is work.
  if (sourceHostPartition) {
    for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
      if (!owns(ownerKey)) {
        items.push(...unsavedDraftItems(files, ownerKey))
      }
    }
  }
  // PTY bindings, remote session ids and shutdown markers are not counted: whether their terminals
  // still run is the terminal gate's verdict, taken before every move; the move drops them.
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    const touchesSource = matches(record.worktreeId) || record.connectionId === scope.targetId
    if (
      touchesSource &&
      !transferableSleepingAgentSession(record, session, scope, terminalTabIds) &&
      !retainedOrphanedSleepingAgentSession(record, scope, sourceTerminalTabIds)
    ) {
      items.push(
        `a ${record.agent} session saved in ${worktreeLabel(record.worktreeId)} that cannot resume on the server: resume it here and let it finish, or close its tab`
      )
    }
  }
  // Client-hosted pages, focus on a project outside the move and ambiguous markdown visibility are
  // not counted: the move never carries the first, and the rest are presentation the server
  // rebuilds. Activity at shutdown is the terminal gate's, like the PTY bindings above.
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    if (owns(ownerKey)) {
      const hostBound = files.filter(
        (file) => file.externalSshTargetId !== undefined || Boolean(file.runtimeEnvironmentId)
      )
      items.push(
        ...unsavedDraftItems(hostBound, ownerKey),
        ...hostBound
          .filter((file) => file.dirtyDraftContent === undefined)
          .map((file) => `the editor tab for ${file.filePath}, which another host opened: close it`)
      )
    }
  }
  for (const [ownerKey, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    if (owns(ownerKey)) {
      items.push(
        ...tabs
          .filter(
            (tab) =>
              tab.executionHostId !== undefined && !isOrcadSourceTabHost(tab.executionHostId, scope)
          )
          .map(
            (tab) =>
              `the tab "${tab.customLabel ?? tab.label}" in ${worktreeLabel(ownerKey)}, which another host runs: close it`
          )
      )
    }
  }
  return items
}

const UNSAVED_DRAFT_PREFIX = 'unsaved changes to '

export function unsavedDraftItems(files: readonly PersistedOpenFile[], ownerKey: string): string[] {
  return files
    .filter((file) => file.dirtyDraftContent !== undefined)
    .map(
      (file) =>
        `${UNSAVED_DRAFT_PREFIX}${file.filePath} in ${worktreeLabel(ownerKey)}: save or discard them`
    )
}

export function isUnsavedDraftItem(item: string): boolean {
  return item.startsWith(UNSAVED_DRAFT_PREFIX)
}

/** The path a worktree id carries, which is what the user sees in the sidebar. */
export function worktreeLabel(ownerKey: string): string {
  const raw = unqualifyOrcadMigrationOwnerKey(ownerKey)
  const separator = raw.indexOf('::')
  return separator === -1 ? raw : raw.slice(separator + 2)
}

export function projectDormantSessionFocus(
  source: WorkspaceSessionState,
  transferred: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  terminalTabIds: ReadonlySet<string>
): void {
  // These scalars are UI focus, not execution ownership. They are safe to carry
  // only from the source host partition and only when they point at an entity
  // already proven dormant and included in the projected session.
  if (orcadMigrationOwnsRepoId(scope, source.activeRepoId)) {
    transferred.activeRepoId = source.activeRepoId
  }
  if (source.activeWorktreeId && orcadMigrationOwnerMatchesScope(source.activeWorktreeId, scope)) {
    transferred.activeWorktreeId = unqualifyOrcadMigrationOwnerKey(source.activeWorktreeId)
  }
  const activeWorkspaceKey =
    source.activeWorkspaceKey && orcadMigrationOwnerMatchesScope(source.activeWorkspaceKey, scope)
      ? unqualifyOrcadMigrationOwnerKey(source.activeWorkspaceKey)
      : null
  if (activeWorkspaceKey && isWorkspaceKey(activeWorkspaceKey)) {
    transferred.activeWorkspaceKey = activeWorkspaceKey
  }
  if (source.activeWorkspaceExecutionHostId === scope.hostId) {
    transferred.activeWorkspaceExecutionHostId = LOCAL_EXECUTION_HOST_ID
  }
  if (source.activeTabId && terminalTabIds.has(source.activeTabId)) {
    transferred.activeTabId = source.activeTabId
  }
}

/** Older builds stamped 'local' on tabs created in an SSH worktree; its owner key proves the host. */
export function isOrcadSourceTabHost(
  executionHostId: string,
  scope: OrcadMigrationSourceScope
): boolean {
  return executionHostId === scope.hostId || executionHostId === LOCAL_EXECUTION_HOST_ID
}

export function projectSessionToDestination(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope
): WorkspaceSessionState {
  const projected = structuredClone(session)
  for (const tabs of Object.values(projected.unifiedTabs ?? {})) {
    for (const tab of tabs) {
      if (tab.executionHostId === scope.hostId) {
        tab.executionHostId = LOCAL_EXECUTION_HOST_ID
      }
    }
  }
  return projected
}

export function transferableSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  terminalTabIds: ReadonlySet<string>
): boolean {
  return (
    sleepingAgentSessionMayLeave(record, scope) &&
    ((record.origin ?? 'worktree-sleep') === 'worktree-sleep' ||
      paneBelongsToTerminalLayout(record, session, terminalTabIds))
  )
}

/** Closed panes keep their resume evidence on the source; migrating must not resurrect their tabs. */
function retainedOrphanedSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  scope: OrcadMigrationSourceScope,
  sourceTerminalTabIds: ReadonlySet<string>
): boolean {
  const ownTab = record.tabId ?? record.paneKey.slice(0, record.paneKey.lastIndexOf(':'))
  return (
    sleepingAgentSessionMayLeave(record, scope) &&
    (record.origin === 'quit' || record.origin === 'live') &&
    // A tab any partition still lists is open, so its record is not an orphan.
    paneBelongsToTabs(record.paneKey, new Set([ownTab])) &&
    !paneBelongsToTabs(record.paneKey, sourceTerminalTabIds)
  )
}

function sleepingAgentSessionMayLeave(
  record: SleepingAgentSessionRecord,
  scope: OrcadMigrationSourceScope
): boolean {
  return (
    orcadMigrationOwnerMatchesScope(record.worktreeId, scope) &&
    (record.connectionId == null || record.connectionId === scope.targetId) &&
    // Older profiles can still contain a worker-resume fence; never discard its authority.
    (!('automaticResumeBlockedBy' in record) || record.automaticResumeBlockedBy === undefined)
  )
}
