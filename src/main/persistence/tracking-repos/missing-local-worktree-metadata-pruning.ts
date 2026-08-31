import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getRepoKind } from '../../../shared/repo-kind'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR, splitWorktreeId } from '../../../shared/worktree/id'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { isFinalAutomationRunStatus } from '../../../shared/automations-types'
import { pruneUnreferencedWorktreeIdentityMeta } from '../loading-store/worktree-identity-metadata'
import {
  addPersistedSessionWorktreeOwners,
  createWorktreeOwnerCandidateCollector
} from '../restoring-sessions/session-worktree-ownership'
import {
  indexMetadataAliasesForWorktreeIds,
  removeRevalidatedLocalWorktreeMetadata,
  type LocalWorktreeMetadataPruneExpectation,
  type NativeLocalWorktreeMetadataScanExpectation
} from './local-worktree-metadata-scan-expectation'

export { captureNativeLocalWorktreeMetadataScanExpectation } from './local-worktree-metadata-scan-expectation'
export type {
  LocalWorktreeMetadataPruneExpectation,
  NativeLocalWorktreeMetadataScanExpectation
} from './local-worktree-metadata-scan-expectation'

function collectPersistedWorkspaceOwners(
  state: PersistedState,
  candidateIds: ReadonlySet<string>,
  platform: NodeJS.Platform
): Set<string> {
  const collector = createWorktreeOwnerCandidateCollector(candidateIds, platform)
  addPersistedSessionWorktreeOwners(state, collector)
  const add = collector.addOwner
  add(state.ui.lastActiveWorktreeId)
  for (const selections of Object.values(state.mobileClientTabSelectionsByDeviceId ?? {})) {
    for (const worktreeId of Object.keys(selections)) {
      add(worktreeId)
    }
  }
  for (const lease of state.sshRemotePtyLeases) {
    add(lease.worktreeId)
  }
  for (const entry of state.migrationUnsupportedPtyEntries) {
    add(entry.worktreeId)
  }
  for (const automation of state.automations) {
    if (automation.enabled && automation.workspaceMode === 'existing') {
      add(automation.workspaceId)
    }
  }
  for (const run of state.automationRuns) {
    if (!isFinalAutomationRunStatus(run.status)) {
      add(run.workspaceId)
    }
  }
  return collector.owners
}

function repoStillMatches(
  state: PersistedState,
  expected: NativeLocalWorktreeMetadataScanExpectation['repo']
): boolean {
  const owners = state.repos.filter((repo) => repo.id === expected.id)
  const current = owners[0]
  return Boolean(
    owners.length === 1 &&
    current &&
    current === expected.expectedRepo &&
    current.path === expected.path &&
    current.connectionId === expected.connectionId &&
    current.executionHostId === expected.executionHostId &&
    getRepoKind(current) === expected.kind &&
    expected.kind === 'git' &&
    !current.connectionId &&
    getRepoExecutionHostId(current) === LOCAL_EXECUTION_HOST_ID
  )
}

function routingStillMatches(
  state: PersistedState,
  expected: NativeLocalWorktreeMetadataScanExpectation
): boolean {
  const currentProject = state.projects.find((project) =>
    project.sourceRepoIds.includes(expected.repo.id)
  )
  return (
    currentProject === expected.routing.expectedProject &&
    currentProject?.updatedAt === expected.routing.expectedProjectUpdatedAt &&
    state.settings === expected.routing.expectedSettings
  )
}

function isValidCandidateId(
  repoId: string,
  worktreeId: string,
  platform: NodeJS.Platform
): boolean {
  const parsed = splitWorktreeId(worktreeId)
  return Boolean(
    parsed?.repoId === repoId &&
    parsed.worktreePath.length > 0 &&
    !isWslUncPath(parsed.worktreePath) &&
    (platform === 'win32'
      ? isWindowsAbsolutePathLike(parsed.worktreePath)
      : parsed.worktreePath.startsWith('/')) &&
    !worktreeId.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)
  )
}

export function pruneSessionlessMissingLocalWorktreeMetadataForRepo(
  state: PersistedState,
  scan: NativeLocalWorktreeMetadataScanExpectation,
  missingMetadata: readonly LocalWorktreeMetadataPruneExpectation[],
  platform = process.platform
): string[] {
  if (
    missingMetadata.length === 0 ||
    !repoStillMatches(state, scan.repo) ||
    !routingStillMatches(state, scan)
  ) {
    return []
  }

  const candidateIds = new Set(missingMetadata.map(({ worktreeId }) => worktreeId))
  const sessionOwners = collectPersistedWorkspaceOwners(state, candidateIds, platform)
  const aliasesByWorktreeId = indexMetadataAliasesForWorktreeIds(state, candidateIds)
  const removedIdentityKeys = new Set<string>()
  const removedIds: string[] = []
  for (const expectation of missingMetadata) {
    const { worktreeId } = expectation
    if (
      !isValidCandidateId(scan.repo.id, worktreeId, platform) ||
      sessionOwners.has(worktreeId) ||
      !removeRevalidatedLocalWorktreeMetadata(
        state,
        expectation,
        aliasesByWorktreeId.get(worktreeId) ?? [],
        removedIdentityKeys
      )
    ) {
      continue
    }
    delete state.worktreeLineageById[worktreeId]
    delete state.workspaceLineageByChildKey[worktreeWorkspaceKey(worktreeId)]
    removedIds.push(worktreeId)
  }
  if (removedIds.length > 0) {
    // Why: a global sweep could delete unrelated unaliased rows from another repo or host.
    pruneUnreferencedWorktreeIdentityMeta(state, removedIdentityKeys)
  }
  return removedIds
}
