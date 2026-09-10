import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  splitWorktreeId
} from '../../../../shared/worktree/id'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { Store } from '../../../persistence/loading-store/store'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../../../persistence/tracking-repos/missing-local-worktree-metadata-pruning'
import { pruneWorkspaceCleanupScanSnapshots } from '../../../workspace-cleanup-scan-snapshot'
import { pruneWorkspaceSpaceAnalysisSnapshots } from '../../../workspace-space-analysis-snapshot'
import { isLocalWorktreeScanGenerationCurrent } from '../../../local-worktree-scan-generation'
import { localWorktreePathsExistOrAreUnverifiable } from '../../../local-worktree-path-presence'
import { worktreeRetentionPathComparisonKey } from '../../../worktree-retention-path-comparison'

type AuthoritativeLocalMetadataPruneArgs = {
  store: Store
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
  if (
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
    // Why: Git can canonicalize a symlinked main checkout differently from the configured path.
    worktreeRetentionPathComparisonKey(repo.path, platform),
    ...gitWorktrees.map((worktree) => worktreeRetentionPathComparisonKey(worktree.path, platform))
  ])
  // Why: only rows a delete could still accept are worth a filesystem probe. This is advisory —
  // `pruneSessionlessMissingLocalWorktreeMetadataForRepo` re-checks authoritatively — so it can only
  // ever shrink the `stat` fan-out, never widen what gets removed (#17775).
  const removableCandidates =
    store.selectProbeableLocalWorktreeMetadataCandidates?.(scan) ?? scan.metadata
  const probeCandidates = removableCandidates.flatMap((metadata) => {
    const { worktreeId } = metadata
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
      return []
    }
    return [{ metadata, pathValue: parsed.worktreePath }]
  })
  const presenceByPath = await pathsExistOrAreUnverifiable(
    probeCandidates.map(({ pathValue }) => pathValue),
    { signal }
  )
  if (!generationCurrent() || !isCallerCurrent()) {
    return result([], generationCurrent())
  }
  const missingMetadata = probeCandidates.flatMap(({ metadata, pathValue }) =>
    presenceByPath.get(pathValue) === false ? [metadata] : []
  )
  if (missingMetadata.length === 0) {
    return result([], generationCurrent())
  }

  if (!generationCurrent() || !isCallerCurrent()) {
    return result([], generationCurrent())
  }
  const removedIds = store.pruneSessionlessMissingLocalWorktreeMetadataForRepo(
    scan,
    missingMetadata
  )
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
  }
  return result(removedIds, generationCurrent())
}
