import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { isRecord } from '../../../shared/orcad-migration/orcad-migration-manifest-fields'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { SESSION_FOCUS_FIELDS } from '../../../shared/workspace-session-host-field-ownership'
import { mergeWorkspaceSessions } from '../../orca-profiles/profile-project-session-state'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'

const MERGED_SESSION_RECORD_FIELDS = [
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'openFilesByWorktree',
  'markdownFrontmatterVisible',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'clientHostedBrowserPagesByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId',
  'terminalPtyIncarnationsByPaneKey',
  'terminalSurfaceTombstonesByPaneKey',
  'sleepingAgentSessionsByPaneKey'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

export type PreparedOrcadMigrationWorkspaceSession = {
  incoming: WorkspaceSessionState | undefined
  merged: WorkspaceSessionState | undefined
}

export function prepareOrcadMigrationWorkspaceSession(
  incoming: WorkspaceSessionState | undefined,
  state: PersistedState
): PreparedOrcadMigrationWorkspaceSession {
  if (!incoming) {
    return { incoming: undefined, merged: undefined }
  }
  assertNoSessionRecordConflicts(state.workspaceSession, incoming)
  assertNoSessionEntityConflicts(state.workspaceSession, incoming)
  const merged = mergeWorkspaceSessions(state.workspaceSession, incoming)
  // Focus is one desktop's selection, not saved state: a host already focused keeps all of its own.
  return {
    incoming,
    merged: hasSessionFocus(state.workspaceSession)
      ? { ...merged, ...sessionFocus(state.workspaceSession) }
      : merged
  }
}

/** Every focus field, so none the host left unset is borrowed from the desktop. */
function sessionFocus(session: WorkspaceSessionState): Partial<WorkspaceSessionState> {
  return Object.fromEntries(SESSION_FOCUS_FIELDS.map((field) => [field, session[field] ?? null]))
}

function hasSessionFocus(session: WorkspaceSessionState): boolean {
  return SESSION_FOCUS_FIELDS.some(
    (field) => session[field] !== undefined && session[field] !== null
  )
}

export function applyPreparedOrcadMigrationWorkspaceSession(
  prepared: PreparedOrcadMigrationWorkspaceSession,
  state: PersistedState
): void {
  if (prepared.merged) {
    state.workspaceSession = prepared.merged
  }
}

function assertNoSessionRecordConflicts(
  existing: WorkspaceSessionState,
  incoming: WorkspaceSessionState
): void {
  for (const field of MERGED_SESSION_RECORD_FIELDS) {
    const existingValue: unknown = existing[field]
    const incomingValue: unknown = incoming[field]
    const existingRecord = isRecord(existingValue) ? existingValue : {}
    const incomingRecord = isRecord(incomingValue) ? incomingValue : {}
    for (const [key, value] of Object.entries(incomingRecord)) {
      const current = existingRecord[key]
      if (
        current !== undefined &&
        serializeOrcadMigrationValue(current) !== serializeOrcadMigrationValue(value)
      ) {
        throw new Error(
          `orcad_migration_dormant_id_conflict:workspace_session:${String(field)}:${key}`
        )
      }
    }
  }
}

function assertNoSessionEntityConflicts(
  existing: WorkspaceSessionState,
  incoming: WorkspaceSessionState
): void {
  const existingOwners = collectOrcadMigrationSessionEntityOwners(existing)
  for (const [key, owner] of collectOrcadMigrationSessionEntityOwners(incoming)) {
    if (owner === '\0') {
      throw new Error(`orcad_migration_dormant_id_conflict:workspace_session:${key}`)
    }
    const currentOwner = existingOwners.get(key)
    if (currentOwner !== undefined && currentOwner !== owner) {
      throw new Error(`orcad_migration_dormant_id_conflict:workspace_session:${key}`)
    }
  }
}

export function collectOrcadMigrationSessionEntityOwners(
  session: WorkspaceSessionState
): Map<string, string> {
  const owners = new Map<string, string>()
  visitOrcadMigrationSessionEntities(session, (key, owner) => {
    const current = owners.get(key)
    // Mark every duplicate, even same-owner repeats within the incoming payload.
    owners.set(key, current === undefined ? owner : '\0')
  })
  return owners
}

/** Unique kind:id identities and their owning worktree or tab. */
export function visitOrcadMigrationSessionEntities(
  session: WorkspaceSessionState,
  add: (key: string, owner: string) => void
): void {
  for (const [owner, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    tabs.forEach((tab) => add(`terminal:${tab.id}`, owner))
  }
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const topologyLeaves = collectLayoutLeafIdsInOrder(layout.root)
    topologyLeaves.forEach((leafId) => add(`terminal-leaf:${leafId}`, tabId))
    const topologyIds = new Set(topologyLeaves)
    const recordIds = new Set(
      [
        layout.ptyIdsByLeafId,
        layout.buffersByLeafId,
        layout.scrollbackRefsByLeafId,
        layout.titlesByLeafId
      ].flatMap((record) => Object.keys(record ?? {}))
    )
    // Stale per-pane records still own data; importing their identity must not overwrite it.
    for (const leafId of recordIds) {
      if (!topologyIds.has(leafId)) {
        add(`terminal-leaf:${leafId}`, tabId)
      }
    }
  }
  for (const [owner, workspaces] of Object.entries(session.browserTabsByWorktree ?? {})) {
    workspaces.forEach((workspace) => add(`browser:${workspace.id}`, owner))
  }
  for (const [owner, pages] of Object.entries(session.clientHostedBrowserPagesByWorktree ?? {})) {
    pages.forEach((page) => add(`client-browser-page:${page.browserPageId}`, owner))
  }
  for (const [owner, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    tabs.forEach((tab) => add(`tab:${tab.id}`, owner))
  }
  for (const [owner, groups] of Object.entries(session.tabGroups ?? {})) {
    groups.forEach((group) => add(`group:${group.id}`, owner))
  }
}
