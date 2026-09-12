import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
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
  assertNoSessionFocusConflicts(state.workspaceSession, incoming)
  assertNoSessionEntityConflicts(state.workspaceSession, incoming)
  return {
    incoming,
    merged: mergeWorkspaceSessions(state.workspaceSession, incoming)
  }
}

function assertNoSessionFocusConflicts(
  existing: WorkspaceSessionState,
  incoming: WorkspaceSessionState
): void {
  const fields = [
    'activeRepoId',
    'activeWorktreeId',
    'activeWorkspaceKey',
    'activeWorkspaceExecutionHostId',
    'activeTabId'
  ] as const
  for (const field of fields) {
    const current = existing[field]
    const next = incoming[field]
    if (
      next !== undefined &&
      next !== null &&
      current !== undefined &&
      current !== null &&
      serializeOrcadMigrationValue(current) !== serializeOrcadMigrationValue(next)
    ) {
      throw new Error(`orcad_migration_dormant_focus_conflict:${field}`)
    }
  }
}

export function applyPreparedOrcadMigrationWorkspaceSession(
  prepared: PreparedOrcadMigrationWorkspaceSession,
  state: PersistedState
): void {
  if (prepared.merged) {
    state.workspaceSession = prepared.merged
  }
}

export function assertCommittedOrcadMigrationWorkspaceSession(
  incoming: WorkspaceSessionState | undefined,
  state: PersistedState
): void {
  if (
    incoming &&
    serializeOrcadMigrationValue(mergeWorkspaceSessions(state.workspaceSession, incoming)) !==
      serializeOrcadMigrationValue(state.workspaceSession)
  ) {
    throw new Error('orcad_migration_receipt_dormant_mismatch:workspace_session')
  }
}

function assertNoSessionRecordConflicts(
  existing: WorkspaceSessionState,
  incoming: WorkspaceSessionState
): void {
  for (const field of MERGED_SESSION_RECORD_FIELDS) {
    const existingRecord = (existing[field] ?? {}) as Record<string, unknown>
    const incomingRecord = (incoming[field] ?? {}) as Record<string, unknown>
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
  const add = (key: string, owner: string): void => {
    const current = owners.get(key)
    // A duplicate entity id is invalid even when both rows claim the same owner. Marking every
    // repeat lets the caller reject duplicates within the incoming payload as well as conflicts
    // with already-committed state.
    owners.set(key, current === undefined ? owner : '\0')
  }
  for (const [owner, tabs] of Object.entries(session.tabsByWorktree)) {
    tabs.forEach((tab) => add(`terminal:${tab.id}`, owner))
  }
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId)) {
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
  return owners
}
