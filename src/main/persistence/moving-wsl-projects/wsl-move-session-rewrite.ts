/**
 * The saved session after a WSL move commits: the desktop's focus follows a moved workspace to the
 * host, and the host's partition starts from the session the move carried, so the first paint
 * shows the moved tabs before the host publishes. Native chats stay on this computer (owner
 * decision, option C), and terminals restart on the host, so neither is seeded.
 */
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import { filterWorkspaceSessionTabs } from '../../../shared/workspace-session-tab-filter'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'
import {
  mergeWorkspaceSessionArrayField,
  mergeWorkspaceSessionRecordField
} from '../../../shared/workspace-session-host-records'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import {
  filterWorkspaceRows,
  workspaceIdsNamedByPartition
} from '../../../shared/workspace-session-stranded-partition-adoption'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { WslMoveRewriteScope } from './wsl-move-rewrite-scope'

type SessionGlobals = Pick<
  WorkspaceSessionState,
  'activeWorktreeId' | 'activeWorkspaceKey' | 'activeWorkspaceExecutionHostId'
>

/** The local partition's focus on the host when it points into the move; null when it does not. */
export function wslMoveSessionGlobalsPatch(
  session: SessionGlobals,
  scope: WslMoveRewriteScope
): WorkspaceSessionPatch | null {
  const host = session.activeWorkspaceExecutionHostId
  // Focus already on a host (the WSL one included) names that host's ids, not the moved local ones.
  if (host && host !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const worktreeId = session.activeWorktreeId
  const key = session.activeWorkspaceKey
  const movedWorktree = worktreeId ? scope.inScope(worktreeId) : false
  const movedKey = key ? scope.inScope(key) : false
  if (!movedWorktree && !movedKey) {
    return null
  }
  const parsedKey = key && movedKey ? parseWorkspaceKey(key) : null
  return {
    activeWorkspaceExecutionHostId: scope.destinationHostId,
    ...(worktreeId && movedWorktree ? { activeWorktreeId: scope.worktreeId(worktreeId) } : {}),
    ...(parsedKey?.type === 'worktree'
      ? {
          activeWorkspaceKey: worktreeWorkspaceKey(scope.worktreeId(parsedKey.worktreeId))
        }
      : {})
  }
}

/**
 * Undo's inverse: focus left on a released project's host copy returns to its copy here, so the
 * reloaded window does not open (and so restart) the host's panes; null when focus is elsewhere.
 */
export function wslMoveReleasedSessionFocusPatch(
  session: SessionGlobals & Pick<WorkspaceSessionState, 'tabsByWorktree'>,
  scope: WslMoveRewriteScope
): WorkspaceSessionPatch | null {
  if (session.activeWorkspaceExecutionHostId !== scope.destinationHostId) {
    return null
  }
  const hostWorktreeId = session.activeWorktreeId
  const key = session.activeWorkspaceKey
  const releasedWorktree = hostWorktreeId ? scope.inScope(hostWorktreeId) : false
  if (!releasedWorktree && !(key && scope.inScope(key))) {
    return null
  }
  if (!releasedWorktree) {
    // A folder workspace keeps its id on the host; only the host changes back.
    return { activeWorkspaceExecutionHostId: LOCAL_EXECUTION_HOST_ID }
  }
  const localWorktreeId =
    Object.keys(session.tabsByWorktree).find(
      (id) => id !== hostWorktreeId && scope.worktreeId(id) === hostWorktreeId
    ) ?? null
  return {
    activeWorkspaceExecutionHostId: LOCAL_EXECUTION_HOST_ID,
    activeWorktreeId: localWorktreeId,
    activeWorkspaceKey: localWorktreeId ? worktreeWorkspaceKey(localWorktreeId) : null
  }
}

// Restart hints for local PTYs; the host decides what to start for its own terminals.
const UNSEEDED_FIELDS: ReadonlySet<string> = new Set(['activeWorktreeIdsOnShutdown'])

export type WslMoveHostSessionSeed = {
  session: WorkspaceSessionState
  workspaceIds: string[]
}

/**
 * `existing` plus the carried rows of every moved workspace it names nothing for and no earlier
 * run seeded, or null when there is none: what the host published, and a seeded tab the user
 * has since closed, are never replaced.
 */
export function wslMoveHostSessionSeed(
  carried: WorkspaceSessionState,
  existing: WorkspaceSessionState,
  scope: WslMoveRewriteScope,
  alreadySeeded: ReadonlySet<string> = new Set()
): WslMoveHostSessionSeed | null {
  const published = workspaceIdsNamedByPartition(existing)
  const stripped = withoutChatTabs(withoutPtyBindings(carried))
  const seeded = new Set(
    [...workspaceIdsNamedByPartition(stripped)].filter(
      (workspaceId) =>
        scope.inScope(workspaceId) && !published.has(workspaceId) && !alreadySeeded.has(workspaceId)
    )
  )
  if (seeded.size === 0) {
    return null
  }
  const rows = filterWorkspaceRows(stripped, (workspaceId) => seeded.has(workspaceId))
  const next = structuredClone(existing)
  for (const [field, ownership] of Object.entries(WORKSPACE_SESSION_FIELD_OWNERSHIP)) {
    if (
      !isSessionField(field) ||
      ownership === 'global' ||
      ownership === 'hostPrivate' ||
      UNSEEDED_FIELDS.has(field)
    ) {
      continue
    }
    if (ownership === 'worktreeArray') {
      mergeWorkspaceSessionArrayField(next, field, rows)
    } else {
      mergeWorkspaceSessionRecordField(next, field, rows)
    }
  }
  return { session: next, workspaceIds: [...seeded] }
}

function isSessionField(field: string): field is keyof WorkspaceSessionState {
  return Object.hasOwn(WORKSPACE_SESSION_FIELD_OWNERSHIP, field)
}

/**
 * This desktop's focus, which names nothing on the host: the host keeps its own, and a host that
 * already has one refuses a manifest naming another (`orcad_migration_dormant_focus_conflict`).
 */
export function withoutDesktopFocus(session: WorkspaceSessionState): WorkspaceSessionState {
  const { activeWorkspaceKey: _key, activeWorkspaceExecutionHostId: _host, ...rest } = session
  return { ...rest, activeRepoId: null, activeWorktreeId: null, activeTabId: null }
}

/** Every local PTY binding (item 36): the host starts its own terminals. */
export function withoutPtyBindings(session: WorkspaceSessionState): WorkspaceSessionState {
  const {
    remoteSessionIdsByTabId: _remoteSessions,
    terminalPtyIncarnationsByPaneKey: _incarnations,
    ...rest
  } = session
  return {
    ...rest,
    tabsByWorktree: Object.fromEntries(
      Object.entries(session.tabsByWorktree).map(([owner, tabs]) => [
        owner,
        tabs.map((tab) => ({ ...tab, ptyId: null }))
      ])
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(session.terminalLayoutsByTabId).map(([tabId, layout]) => {
        const { ptyIdsByLeafId: _ptyIds, ...unbound } = layout
        return [tabId, unbound]
      })
    )
  }
}

function isChatTab(tab: Pick<Tab, 'contentType'>): boolean {
  return tab.contentType === 'agent-session'
}

/** Chat tabs, and the groups, focus and sleeping records that name them; they stay local. */
function withoutChatTabs(session: WorkspaceSessionState): WorkspaceSessionState {
  const chatIds = new Set(
    Object.values(session.unifiedTabs ?? {}).flatMap((tabs) =>
      tabs.filter(isChatTab).map((tab) => tab.id)
    )
  )
  if (chatIds.size === 0) {
    return session
  }
  const filtered = filterWorkspaceSessionTabs(session, (_owner, tab) => !isChatTab(tab))
  return {
    ...filtered,
    ...(session.sleepingAgentSessionsByPaneKey
      ? {
          sleepingAgentSessionsByPaneKey: Object.fromEntries(
            Object.entries(session.sleepingAgentSessionsByPaneKey).filter(
              ([, record]) => !record.tabId || !chatIds.has(record.tabId)
            )
          )
        }
      : {})
  }
}
