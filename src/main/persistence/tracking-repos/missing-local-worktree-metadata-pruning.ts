import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { getRepoKind } from '../../../shared/repo-kind'
import { sshRemotePtyLeaseAllowsReattach } from '../../../shared/ssh-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoIdFromWorktreeId,
  splitWorktreeId
} from '../../../shared/worktree/id'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { isFinalAutomationRunStatus } from '../../../shared/automations/history/automation-run'
import { pruneUnreferencedWorktreeIdentityMeta } from '../loading-store/worktree-metadata/worktree-identity-metadata'
import {
  addPersistedSessionWorktreeOwners,
  addWorkspaceSessionWorktreeOwners,
  createWorktreeOwnerCandidateCollector,
  getPersistedWorktreeOwnerId,
  type WorktreeOwnerCandidateCollector
} from '../restoring-sessions/session-worktree-ownership'
import {
  removeWorkspaceSessionOwners,
  withoutWslMoveFrozenOwners
} from '../restoring-sessions/session-owner-removal'
import {
  indexMetadataAliasesForWorktreeIds,
  isLocallyRemovableWorktreeMetadataRow,
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
  addNonSessionWorkspaceOwners(state, collector)
  return collector.owners
}

/** Owners outside saved session layout: a live lease, automation or phone selection still uses the workspace. */
function addNonSessionWorkspaceOwners(
  state: PersistedState,
  collector: WorktreeOwnerCandidateCollector
): void {
  const add = collector.addOwner
  add(state.ui.lastActiveWorktreeId)
  for (const selections of Object.values(state.mobileClientTabSelectionsByDeviceId ?? {})) {
    for (const worktreeId of Object.keys(selections)) {
      add(worktreeId)
    }
  }
  for (const lease of state.sshRemotePtyLeases) {
    // Unreattachable routing tombstones own no workspace; counting them pinned metadata forever (#17775).
    if (!sshRemotePtyLeaseAllowsReattach(lease)) {
      continue
    }
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

/** Prefilter before stat; authoritative deletion rechecks everything, so this cannot widen removal. */
export function selectProbeableLocalWorktreeMetadataCandidates(
  state: PersistedState,
  scan: NativeLocalWorktreeMetadataScanExpectation,
  platform = process.platform
): readonly LocalWorktreeMetadataPruneExpectation[] {
  const candidateIds = new Set(scan.metadata.map(({ worktreeId }) => worktreeId))
  if (candidateIds.size === 0) {
    return scan.metadata
  }
  const sessionOwners = collectPersistedWorkspaceOwners(state, candidateIds, platform)
  const aliasesByWorktreeId = indexMetadataAliasesForWorktreeIds(state, candidateIds)
  return scan.metadata.filter(
    ({ worktreeId }) =>
      isValidCandidateId(scan.repo.id, worktreeId, platform) &&
      !sessionOwners.has(worktreeId) &&
      isLocallyRemovableWorktreeMetadataRow(
        state,
        worktreeId,
        aliasesByWorktreeId.get(worktreeId) ?? []
      )
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
    delete state.crossStoreLineageByChildKey?.[worktreeWorkspaceKey(worktreeId)]
    removedIds.push(worktreeId)
  }
  if (removedIds.length > 0) {
    // Limit identity cleanup to removed rows or unrelated repo/host metadata could disappear.
    pruneUnreferencedWorktreeIdentityMeta(state, removedIdentityKeys)
  }
  return removedIds
}

/** Worktree IDs of this repo that only the local saved session still names. */
export function selectLocalWorktreeSessionOwnersForRepo(
  session: WorkspaceSessionState,
  repoId: string,
  platform = process.platform
): string[] {
  const owners = new Set<string>()
  addWorkspaceSessionWorktreeOwners(session, {
    owners,
    addOwner: (ownerKey) => {
      const worktreeId = getPersistedWorktreeOwnerId(ownerKey)
      if (
        worktreeId &&
        getRepoIdFromWorktreeId(worktreeId) === repoId &&
        isValidCandidateId(repoId, worktreeId, platform)
      ) {
        owners.add(worktreeId)
      }
    }
  })
  return [...owners]
}

function hasUnsavedDraft(state: PersistedState, worktreeId: string): boolean {
  const ownerKeys = [worktreeId, worktreeWorkspaceKey(worktreeId)]
  return [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})].some(
    (session) =>
      ownerKeys.some((ownerKey) =>
        session?.openFilesByWorktree?.[ownerKey]?.some(
          (file) => file.dirtyDraftContent !== undefined
        )
      )
  )
}

/** Drop local saved session state for worktrees an authoritative scan no longer lists and whose
 *  folders are gone. Unsaved drafts, the active workspace and non-session owners keep theirs. */
export function pruneMissingLocalWorktreeSessionsForRepo(
  state: PersistedState,
  scan: NativeLocalWorktreeMetadataScanExpectation,
  missingWorktreeIds: readonly string[],
  platform = process.platform
): string[] {
  if (
    missingWorktreeIds.length === 0 ||
    !repoStillMatches(state, scan.repo) ||
    !routingStillMatches(state, scan)
  ) {
    return []
  }
  const candidateIds = new Set(
    missingWorktreeIds.filter((worktreeId) =>
      isValidCandidateId(scan.repo.id, worktreeId, platform)
    )
  )
  const collector = createWorktreeOwnerCandidateCollector(candidateIds, platform)
  addNonSessionWorkspaceOwners(state, collector)
  const session = state.workspaceSession
  collector.addOwner(session.activeWorktreeId)
  collector.addOwner(session.activeWorkspaceKey)
  const aliasesByWorktreeId = indexMetadataAliasesForWorktreeIds(state, candidateIds)
  // A metadata row that may not be pruned (an archived checkout, another host) still names a workspace.
  const isKnownWorkspace = (worktreeId: string): boolean => {
    const aliases = aliasesByWorktreeId.get(worktreeId) ?? []
    const hasMetadata = Boolean(state.worktreeMeta[worktreeId]) || aliases.length > 0
    return hasMetadata && !isLocallyRemovableWorktreeMetadataRow(state, worktreeId, aliases)
  }
  const removedIds = [...candidateIds].filter(
    (worktreeId) =>
      !collector.owners.has(worktreeId) &&
      !hasUnsavedDraft(state, worktreeId) &&
      !isKnownWorkspace(worktreeId)
  )
  const ownerKeys = withoutWslMoveFrozenOwners(
    new Set(removedIds.flatMap((worktreeId) => [worktreeId, worktreeWorkspaceKey(worktreeId)]))
  )
  if (ownerKeys.size === 0) {
    return []
  }
  state.workspaceSession = removeWorkspaceSessionOwners(session, ownerKeys)!
  return removedIds.filter((worktreeId) => ownerKeys.has(worktreeId))
}
