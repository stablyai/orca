import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { markdownFileIdCandidates } from '../../orca-profiles/profile-session-owner-transfer'
import { removeWorkspaceSessionOwners } from '../restoring-sessions/session-owner-removal'
import {
  orcadMigrationOwnerMatchesScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'
import { collectSessionOwnerKeys } from './orcad-source-workspace-session-fragments'

export function removeOwnedSessionState(
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
  const next = removeWorkspaceSessionOwners(session, ownerKeys) ?? session
  // Selection-only sessions and canonical workspace keys need the same scoped retirement.
  const retired = next === session ? structuredClone(session) : next
  if (retired.activeRepoId && scope.repoIds.has(retired.activeRepoId)) {
    retired.activeRepoId = null
  }
  if (orcadMigrationOwnerMatchesScope(retired.activeWorktreeId, scope)) {
    retired.activeWorktreeId = null
  }
  if (orcadMigrationOwnerMatchesScope(retired.activeWorkspaceKey, scope)) {
    retired.activeWorkspaceKey = null
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
    delete retired.terminalTopologyRevisionByRepoId?.[repoId]
  }
  return retired
}
