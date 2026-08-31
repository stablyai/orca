import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { worktreeRetentionIdComparisonKey } from '../../worktree-retention-path-comparison'

type WorkspaceSessionWorktreeReferenceKind =
  | 'none'
  | 'direct'
  | 'owner-keyed'
  | 'owner-keyed-row-arrays'
  | 'owner-keyed-browser-row-arrays'
  | 'worktree-id-array'
  | 'row-record'
  | 'row-arrays'
  | 'browser-row-arrays'

/** Every persisted session field must state how, if at all, it can name a worktree owner. */
export const WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND = {
  activeRepoId: 'none',
  activeWorkspaceKey: 'direct',
  activeWorkspaceExecutionHostId: 'none',
  activeWorktreeId: 'direct',
  activeTabId: 'none',
  tabsByWorktree: 'owner-keyed-row-arrays',
  terminalLayoutsByTabId: 'none',
  activeWorktreeIdsOnShutdown: 'worktree-id-array',
  openFilesByWorktree: 'owner-keyed-row-arrays',
  activeFileIdByWorktree: 'owner-keyed',
  markdownFrontmatterVisible: 'none',
  browserTabsByWorktree: 'owner-keyed-browser-row-arrays',
  browserPagesByWorkspace: 'browser-row-arrays',
  activeBrowserTabIdByWorktree: 'owner-keyed',
  clientHostedBrowserPagesByWorktree: 'owner-keyed',
  clientHostedBrowserCloseIntentsByEnvironment: 'row-arrays',
  activeTabTypeByWorktree: 'owner-keyed',
  browserUrlHistory: 'none',
  workspaceDocHistory: 'none',
  activeTabIdByWorktree: 'owner-keyed',
  unifiedTabs: 'owner-keyed-row-arrays',
  tabGroups: 'owner-keyed-row-arrays',
  tabGroupLayouts: 'owner-keyed',
  activeGroupIdByWorktree: 'owner-keyed',
  activeConnectionIdsAtShutdown: 'none',
  remoteSessionIdsByTabId: 'none',
  lastVisitedAtByWorktreeId: 'owner-keyed',
  defaultTerminalTabsAppliedByWorktreeId: 'owner-keyed',
  sleepingAgentSessionsByPaneKey: 'row-record',
  terminalPtyIncarnationsByPaneKey: 'none',
  terminalTopologyRevisionByRepoId: 'none',
  terminalSurfaceTombstonesByPaneKey: 'row-record',
  closedTerminalTabTombstonesByTabId: 'row-record'
} as const satisfies Record<keyof WorkspaceSessionState, WorkspaceSessionWorktreeReferenceKind>

type WorktreeRow = { worktreeId?: string | null }
type BrowserWorktreeRow = WorktreeRow & {
  docLocation?: { worktreeId?: string | null } | null
}

export type WorktreeOwnerCandidateCollector = Readonly<{
  owners: Set<string>
  addOwner: (ownerKey: string | null | undefined) => void
}>

export function getPersistedWorktreeOwnerId(ownerKey: string | null | undefined): string | null {
  if (!ownerKey) {
    return null
  }
  if (isWorktreeHostIdentity(ownerKey)) {
    return getWorktreeIdFromHostIdentity(ownerKey) || null
  }
  const scope = parseWorkspaceKey(ownerKey)
  if (scope?.type === 'folder') {
    return null
  }
  return scope?.type === 'worktree' ? scope.worktreeId : ownerKey
}

export function createWorktreeOwnerCandidateCollector(
  candidateIds: ReadonlySet<string>,
  platform: NodeJS.Platform = process.platform,
  owners: Set<string> = new Set<string>()
): WorktreeOwnerCandidateCollector {
  const candidateIdsByComparisonKey = new Map<string, string[]>()
  for (const candidateId of candidateIds) {
    const comparisonKey = worktreeRetentionIdComparisonKey(candidateId, platform)
    if (!comparisonKey) {
      continue
    }
    const matches = candidateIdsByComparisonKey.get(comparisonKey) ?? []
    matches.push(candidateId)
    candidateIdsByComparisonKey.set(comparisonKey, matches)
  }
  return {
    owners,
    addOwner: (ownerKey) => {
      const worktreeId =
        ownerKey && candidateIds.has(ownerKey) ? ownerKey : getPersistedWorktreeOwnerId(ownerKey)
      if (!worktreeId) {
        return
      }
      const comparisonKey = worktreeRetentionIdComparisonKey(worktreeId, platform)
      const equivalentCandidates = comparisonKey
        ? candidateIdsByComparisonKey.get(comparisonKey)
        : undefined
      if (equivalentCandidates) {
        for (const candidateId of equivalentCandidates) {
          owners.add(candidateId)
        }
      } else if (candidateIds.has(worktreeId)) {
        owners.add(worktreeId)
      }
    }
  }
}

function collectRecordKeys(
  value: unknown,
  add: (ownerKey: string | null | undefined) => void
): void {
  for (const ownerKey of Object.keys((value ?? {}) as Record<string, unknown>)) {
    add(ownerKey)
  }
}

function collectWorktreeRows(
  rows: unknown,
  add: (ownerKey: string | null | undefined) => void
): void {
  if (!Array.isArray(rows)) {
    return
  }
  for (const row of rows as WorktreeRow[]) {
    add(row?.worktreeId)
  }
}

function collectBrowserRows(
  rows: unknown,
  add: (ownerKey: string | null | undefined) => void
): void {
  if (!Array.isArray(rows)) {
    return
  }
  for (const row of rows as BrowserWorktreeRow[]) {
    add(row?.worktreeId)
    add(row?.docLocation?.worktreeId)
  }
}

function collectSessionFieldOwners(
  value: unknown,
  kind: WorkspaceSessionWorktreeReferenceKind,
  add: (ownerKey: string | null | undefined) => void
): void {
  switch (kind) {
    case 'none':
      return
    case 'direct':
      add(typeof value === 'string' ? value : null)
      return
    case 'owner-keyed':
      collectRecordKeys(value, add)
      return
    case 'owner-keyed-row-arrays':
    case 'owner-keyed-browser-row-arrays':
      for (const [ownerKey, rows] of Object.entries((value ?? {}) as Record<string, unknown>)) {
        add(ownerKey)
        if (kind === 'owner-keyed-browser-row-arrays') {
          collectBrowserRows(rows, add)
        } else {
          collectWorktreeRows(rows, add)
        }
      }
      return
    case 'worktree-id-array':
      for (const ownerKey of (value ?? []) as string[]) {
        add(ownerKey)
      }
      return
    case 'row-record':
      for (const row of Object.values((value ?? {}) as Record<string, WorktreeRow>)) {
        add(row?.worktreeId)
      }
      return
    case 'row-arrays':
    case 'browser-row-arrays':
      for (const rows of Object.values((value ?? {}) as Record<string, unknown>)) {
        if (kind === 'browser-row-arrays') {
          collectBrowserRows(rows, add)
        } else {
          collectWorktreeRows(rows, add)
        }
      }
  }
}

export function collectWorkspaceSessionWorktreeOwners(
  session: WorkspaceSessionState,
  candidateIds: ReadonlySet<string>,
  platform: NodeJS.Platform = process.platform,
  owners: Set<string> = new Set<string>()
): Set<string> {
  const collector = createWorktreeOwnerCandidateCollector(candidateIds, platform, owners)
  addWorkspaceSessionWorktreeOwners(session, collector)
  return owners
}

function addWorkspaceSessionWorktreeOwners(
  session: WorkspaceSessionState,
  collector: WorktreeOwnerCandidateCollector
): void {
  for (const field of Object.keys(
    WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND
  ) as (keyof WorkspaceSessionState)[]) {
    collectSessionFieldOwners(
      session[field],
      WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND[field],
      collector.addOwner
    )
  }
}

export function addPersistedSessionWorktreeOwners(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  collector: WorktreeOwnerCandidateCollector
): void {
  addWorkspaceSessionWorktreeOwners(state.workspaceSession, collector)
  for (const session of Object.values(state.workspaceSessionsByHostId ?? {})) {
    if (session) {
      addWorkspaceSessionWorktreeOwners(session, collector)
    }
  }
}

export function collectPersistedSessionWorktreeOwners(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  candidateIds: ReadonlySet<string>,
  platform: NodeJS.Platform = process.platform
): Set<string> {
  const collector = createWorktreeOwnerCandidateCollector(candidateIds, platform)
  addPersistedSessionWorktreeOwners(state, collector)
  return collector.owners
}
