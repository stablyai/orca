import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifest,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { OrcadMigrationTerminalScrollbackSnapshot } from '../../../shared/orcad-migration-scrollback'
import {
  extractSessionOwnersForTransfer,
  hasTransferredSessionState
} from '../../orca-profiles/profile-session-owner-transfer'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey
} from './orcad-source-scope'
import {
  countUnrepresentableMarkdownState,
  countUnsupportedSessionState,
  projectDormantSessionFocus,
  projectSessionToDestination,
  shutdownMarkerHasTerminalAuthority,
  transferableSleepingAgentSession
} from './orcad-source-workspace-session-eligibility'
import { collectOwnedTerminalTabIds } from './orcad-source-workspace-session-layout'
import {
  mergeSessionFragments,
  sessionPartitions
} from './orcad-source-workspace-session-fragments'
import { removeOwnedSessionState } from './orcad-source-workspace-session-retirement'
import {
  hasDuplicateOrcadMigrationScrollbackDescriptors,
  projectOrcadMigrationSessionScrollback
} from './orcad-source-scrollback-state'

export type OrcadMigrationSourceWorkspaceSessionInspection = {
  payload: WorkspaceSessionState | undefined
  snapshots: OrcadMigrationTerminalScrollbackSnapshot[]
  blockedCount: number
}

export function collectOrcadMigrationSourceWorkspaceSession(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload,
  storage?: TerminalScrollbackSnapshotStorage
): OrcadMigrationSourceWorkspaceSessionInspection {
  const scope = createOrcadMigrationSourceScope({ source, catalog })
  const fragments: WorkspaceSessionState[] = []
  const snapshots: OrcadMigrationTerminalScrollbackSnapshot[] = []
  let blockedCount = 0
  for (const [partitionId, session] of sessionPartitions(state, LOCAL_EXECUTION_HOST_ID)) {
    const sourceHostPartition = partitionId === scope.hostId
    const terminalTabIds = collectOwnedTerminalTabIds(session, scope)
    blockedCount += countUnsupportedSessionState(
      state,
      session,
      scope,
      sourceHostPartition,
      terminalTabIds
    )
    blockedCount += countUnrepresentableMarkdownState(session, scope, sourceHostPartition)
    const fragment = extractSessionOwnersForTransfer(session, {
      mapOwnerKey: (ownerKey) =>
        orcadMigrationOwnerMatchesScope(ownerKey, scope)
          ? unqualifyOrcadMigrationOwnerKey(ownerKey)
          : null,
      mapWorktreeId: unqualifyOrcadMigrationOwnerKey,
      projectSessionFocus: sourceHostPartition
        ? ({ source, transferred, terminalTabIds }) =>
            projectDormantSessionFocus(source, transferred, scope, terminalTabIds)
        : undefined,
      projectSleepingAgentSession: (record) =>
        transferableSleepingAgentSession(record, session, scope, terminalTabIds)
          ? {
              ...structuredClone(record),
              worktreeId: unqualifyOrcadMigrationOwnerKey(record.worktreeId),
              connectionId: null
            }
          : null
    })
    // A shutdown marker is only a reconnect hint. Once the source has no live
    // PTY authority for that worktree, carrying it would make the destination
    // try to resurrect a process that no longer exists.
    if (fragment.activeWorktreeIdsOnShutdown) {
      fragment.activeWorktreeIdsOnShutdown = fragment.activeWorktreeIdsOnShutdown.filter(
        (worktreeId) =>
          shutdownMarkerHasTerminalAuthority(state, session, scope, sourceHostPartition, worktreeId)
      )
      if (fragment.activeWorktreeIdsOnShutdown.length === 0) {
        delete fragment.activeWorktreeIdsOnShutdown
      }
    }
    if (hasTransferredSessionState(fragment)) {
      const projected = projectOrcadMigrationSessionScrollback(
        projectSessionToDestination(fragment, scope),
        storage
      )
      blockedCount += projected.blockedCount
      snapshots.push(...projected.snapshots)
      fragments.push(projected.session)
    }
  }
  if (hasDuplicateOrcadMigrationScrollbackDescriptors(snapshots)) {
    blockedCount += 1
  }
  if (blockedCount > 0 || fragments.length === 0) {
    return { payload: undefined, snapshots: [], blockedCount }
  }
  const merged = mergeSessionFragments(fragments)
  return merged
    ? { payload: merged, snapshots, blockedCount: 0 }
    : { payload: undefined, snapshots: [], blockedCount: 1 }
}

export function retireOrcadMigrationSourceWorkspaceSession(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  if (!manifest.payload.dormantState?.workspaceSession) {
    return
  }
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload
  })
  state.workspaceSession = removeOwnedSessionState(state.workspaceSession, scope)
  for (const [hostId, session] of Object.entries(state.workspaceSessionsByHostId ?? {})) {
    if (session) {
      state.workspaceSessionsByHostId![hostId as keyof typeof state.workspaceSessionsByHostId] =
        removeOwnedSessionState(session, scope)
    }
  }
}

export function assertOrcadMigrationSourceWorkspaceSessionRetired(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  if (!manifest.payload.dormantState?.workspaceSession) {
    return
  }
  const current = collectOrcadMigrationSourceWorkspaceSession(
    state,
    manifest.source,
    manifest.payload
  )
  if (current.payload || current.blockedCount > 0) {
    throw new Error('orcad_migration_source_workspace_session_reappeared')
  }
}
