import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import { isWindowsAbsolutePathLike } from '../../../../shared/file-access/cross-platform-path'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  splitWorktreeId
} from '../../../../shared/worktree/id'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { isWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import type { Store } from '../../../persistence/loading-store/store'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../../../persistence/tracking-repos/missing-local-worktree-metadata-pruning'
import { pruneWorkspaceCleanupScanSnapshots } from '../../../workspaces/cleanup/workspace-cleanup-scan-snapshot'
import { pruneWorkspaceSpaceAnalysisSnapshots } from '../../../workspaces/space-analysis/workspace-space-analysis-snapshot'
import { isLocalWorktreeScanGenerationCurrent } from '../../../workspaces/catalog/local-worktree-scan-generation'
import { localWorktreePathsExistOrAreUnverifiable } from '../../../workspaces/catalog/local-worktree-path-presence'
import { worktreeRetentionPathComparisonKey } from '../../../workspaces/catalog/worktree-retention-path-comparison'
import { isWslMoveRepoBlocked } from '../../../persistence/moving-wsl-projects/orchestration/wsl-move-background-backoff'

type AuthoritativeLocalMetadataPruneStore = Pick<
  Store,
  'getRepos' | 'pruneSessionlessMissingLocalWorktreeMetadataForRepo' | 'getProfileStorageDirectory'
> &
  Partial<
    Pick<
      Store,
      | 'selectProbeableLocalWorktreeMetadataCandidates'
      | 'selectRemovableLocalWorktreeSessionOwnersForRepo'
      | 'pruneMissingLocalWorktreeSessionsForRepo'
    >
  >

export function canPruneAuthoritativeLocalMetadata<
  T extends Partial<AuthoritativeLocalMetadataPruneStore>
>(store: T): store is T & AuthoritativeLocalMetadataPruneStore {
  return (
    typeof store.getRepos === 'function' &&
    typeof store.pruneSessionlessMissingLocalWorktreeMetadataForRepo === 'function' &&
    typeof store.getProfileStorageDirectory === 'function'
  )
}

type AuthoritativeLocalMetadataPruneArgs = {
  store: AuthoritativeLocalMetadataPruneStore
  repo: Repo
  gitWorktrees: readonly GitWorktreeInfo[]
  scan: NativeLocalWorktreeMetadataScanExpectation
  scanGeneration: number
  platform?: NodeJS.Platform
  pathsExistOrAreUnverifiable?: (
    pathValues: readonly string[],
    options?: { signal?: AbortSignal }
  ) => Promise<ReadonlyMap<string, boolean>>
  isCallerCurrent?: () => boolean
  signal?: AbortSignal
}

export type AuthoritativeLocalMetadataPruneResult = Readonly<{
  removedWorktreeIds: readonly string[]
  preservedMetadataCandidateIds: ReadonlySet<string>
  scanGenerationCurrent: boolean
}>

export async function pruneMetadataMissingFromAuthoritativeLocalScan({
  store,
  repo,
  gitWorktrees,
  scan,
  scanGeneration,
  platform = process.platform,
  pathsExistOrAreUnverifiable = localWorktreePathsExistOrAreUnverifiable,
  isCallerCurrent = () => true,
  signal
}: AuthoritativeLocalMetadataPruneArgs): Promise<AuthoritativeLocalMetadataPruneResult> {
  const capturedCandidateIds = scan.metadata.map(({ worktreeId }) => worktreeId)
  const result = (
    removedWorktreeIds: readonly string[],
    scanGenerationCurrent: boolean
  ): AuthoritativeLocalMetadataPruneResult => {
    const removedIds = new Set(removedWorktreeIds)
    return {
      removedWorktreeIds,
      preservedMetadataCandidateIds: new Set(
        capturedCandidateIds.filter((worktreeId) => !removedIds.has(worktreeId))
      ),
      scanGenerationCurrent
    }
  }
  const generationCurrent = () => isLocalWorktreeScanGenerationCurrent(repo.id, scanGeneration)
  const repoOwners = store.getRepos().filter((candidate) => candidate.id === repo.id)
  // A WSL move can hide live paths temporarily; defer pruning until it settles.
  if (
    isWslMoveRepoBlocked(repo) ||
    !generationCurrent() ||
    !isCallerCurrent() ||
    gitWorktrees.length === 0 ||
    repoOwners.length !== 1 ||
    repo.id !== scan.repo.id ||
    repo.path !== scan.repo.path ||
    repo.connectionId ||
    isFolderRepo(repo) ||
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
    (platform === 'win32' &&
      (isWslUncPath(repo.path) || gitWorktrees.some(({ path }) => isWslUncPath(path))))
  ) {
    return result([], generationCurrent())
  }

  const livePathKeys = new Set([
    // Retain the configured main path even if Git canonicalized its symlink.
    worktreeRetentionPathComparisonKey(repo.path, platform),
    ...gitWorktrees.map((worktree) => worktreeRetentionPathComparisonKey(worktree.path, platform))
  ])
  const isProbeable = (worktreeId: string): string | null => {
    const parsed = splitWorktreeId(worktreeId)
    const nativeAbsolute = parsed
      ? platform === 'win32'
        ? isWindowsAbsolutePathLike(parsed.worktreePath)
        : parsed.worktreePath.startsWith('/')
      : false
    if (
      parsed?.repoId !== repo.id ||
      !nativeAbsolute ||
      isWslUncPath(parsed.worktreePath) ||
      worktreeId.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR) ||
      livePathKeys.has(worktreeRetentionPathComparisonKey(parsed.worktreePath, platform))
    ) {
      return null
    }
    return parsed.worktreePath
  }
  // Advisory eligibility shrinks stat fan-out; deletion still rechecks authoritatively (#17775).
  const removableCandidates =
    store.selectProbeableLocalWorktreeMetadataCandidates?.(scan) ?? scan.metadata
  const probeCandidates = removableCandidates.flatMap((metadata) => {
    const pathValue = isProbeable(metadata.worktreeId)
    return pathValue ? [{ metadata, pathValue }] : []
  })
  // Saved session state of a deleted worktree outlives its metadata; probe those owners too.
  const sessionCandidates = (
    store.selectRemovableLocalWorktreeSessionOwnersForRepo?.(repo.id) ?? []
  ).flatMap((worktreeId) => {
    const pathValue = isProbeable(worktreeId)
    return pathValue ? [{ worktreeId, pathValue }] : []
  })
  const presenceByPath = await pathsExistOrAreUnverifiable(
    [
      ...new Set([
        ...probeCandidates.map(({ pathValue }) => pathValue),
        ...sessionCandidates.map(({ pathValue }) => pathValue)
      ])
    ],
    { signal }
  )
  if (!generationCurrent() || !isCallerCurrent()) {
    return result([], generationCurrent())
  }
  const missingSessionIds = sessionCandidates.flatMap(({ worktreeId, pathValue }) =>
    presenceByPath.get(pathValue) === false ? [worktreeId] : []
  )
  let missingMetadata = probeCandidates.flatMap(({ metadata, pathValue }) =>
    presenceByPath.get(pathValue) === false ? [metadata] : []
  )
  if (missingMetadata.length === 0 && missingSessionIds.length === 0) {
    return result([], generationCurrent())
  }

  // Path probes yield, allowing a WSL move to begin after the entry guard.
  if (!generationCurrent() || !isCallerCurrent() || isWslMoveRepoBlocked(repo)) {
    return result([], generationCurrent())
  }
  const releasedIds = new Set(
    missingSessionIds.length > 0
      ? (store.pruneMissingLocalWorktreeSessionsForRepo?.(scan, missingSessionIds) ?? [])
      : []
  )
  if (releasedIds.size > 0) {
    // The advisory filter skipped these rows while a session still owned them.
    const probedIds = new Set(probeCandidates.map(({ metadata }) => metadata.worktreeId))
    missingMetadata = [
      ...missingMetadata,
      ...scan.metadata.filter(
        ({ worktreeId }) => releasedIds.has(worktreeId) && !probedIds.has(worktreeId)
      )
    ]
  }
  const removedIds =
    missingMetadata.length > 0
      ? store.pruneSessionlessMissingLocalWorktreeMetadataForRepo(scan, missingMetadata)
      : []
  if (removedIds.length > 0) {
    const snapshotDirectory = store.getProfileStorageDirectory()
    const targets: {
      worktreeId: string
      executionHostId: typeof LOCAL_EXECUTION_HOST_ID
    }[] = removedIds.map((worktreeId) => ({
      worktreeId,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    }))
    void pruneWorkspaceCleanupScanSnapshots(snapshotDirectory, targets)
    void pruneWorkspaceSpaceAnalysisSnapshots(snapshotDirectory, targets)
    for (const worktreeId of removedIds) {
      agentHookServer.dropStatusEntriesForRemovedWorktree(worktreeId, LOCAL_EXECUTION_HOST_ID)
    }
  }
  return result(removedIds, generationCurrent())
}
