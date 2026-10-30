import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { markdownFileIdCandidates } from '../../orca-profiles/profile-session-markdown-transfer'
import { removeWorkspaceSessionOwners } from '../restoring-sessions/session-owner-removal'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  orcadMigrationOwnsRepoId,
  orcadMigrationPartitionScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import { collectSessionOwnerKeys } from './orcad-source-workspace-session-fragments'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'

/** Mutate a delta-view copy only. */
export function subtractOrcadMigrationSourceWorkspaceSession(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  if (!manifest.payload.dormantState?.workspaceSession) {
    return
  }
  subtractOrcadMigrationScopeWorkspaceSession(state, manifest)
}

/** Include scoped session state that earlier migrations could not carry. */
export function subtractOrcadMigrationScopeWorkspaceSession(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  state.workspaceSession = removeOwnedSessionState(
    state.workspaceSession,
    orcadMigrationPartitionScope(scope, LOCAL_EXECUTION_HOST_ID)
  )
  const partitions = state.workspaceSessionsByHostId
  if (partitions) {
    state.workspaceSessionsByHostId = Object.fromEntries(
      Object.entries(partitions).map(([hostId, session]) => [
        hostId,
        session
          ? removeOwnedSessionState(session, orcadMigrationPartitionScope(scope, hostId))
          : session
      ])
    )
  }
}

function removeOwnedSessionState(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope
): WorkspaceSessionState {
  const ownerKeys = new Set(
    [...collectSessionOwnerKeys(session)].filter((ownerKey) =>
      orcadMigrationOwnerMatchesScope(ownerKey, scope)
    )
  )
  const removedMarkdownFileIds = new Set<string>()
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    if (!orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    for (const file of files) {
      markdownFileIdCandidates(file.filePath, ownerKey, file.runtimeEnvironmentId).forEach((id) =>
        removedMarkdownFileIds.add(id)
      )
    }
  }
  // Destination focus names the same IDs and must survive source subtraction.
  const retargetedFocus = isOrcadRuntimeHostFocus(session)
    ? {
        activeRepoId: session.activeRepoId,
        activeWorktreeId: session.activeWorktreeId,
        activeWorkspaceKey: session.activeWorkspaceKey,
        activeTabId: session.activeTabId
      }
    : null
  const next = removeWorkspaceSessionOwners(session, ownerKeys) ?? session
  // Selection-only sessions and canonical keys also need scoped subtraction.
  const retired = next === session ? structuredClone(session) : next
  if (retargetedFocus) {
    Object.assign(retired, retargetedFocus)
  } else {
    if (orcadMigrationOwnsRepoId(scope, retired.activeRepoId)) {
      retired.activeRepoId = null
    }
    if (orcadMigrationOwnerMatchesScope(retired.activeWorktreeId, scope)) {
      retired.activeWorktreeId = null
    }
    if (orcadMigrationOwnerMatchesScope(retired.activeWorkspaceKey, scope)) {
      retired.activeWorkspaceKey = null
    }
  }
  if (retired.activeWorkspaceExecutionHostId === scope.hostId) {
    retired.activeWorkspaceExecutionHostId = null
  }
  if (retired.markdownFrontmatterVisible) {
    retired.markdownFrontmatterVisible = Object.fromEntries(
      Object.entries(retired.markdownFrontmatterVisible).filter(
        ([fileId]) => !removedMarkdownFileIds.has(fileId)
      )
    )
  }
  for (const repoId of scope.repoIds) {
    if (!scope.sharedRepoIds.has(repoId)) {
      delete retired.terminalTopologyRevisionByRepoId?.[repoId]
    }
  }
  return retired
}

function isOrcadRuntimeHostFocus(session: WorkspaceSessionState): boolean {
  return parseExecutionHostId(session.activeWorkspaceExecutionHostId)?.kind === 'runtime'
}
