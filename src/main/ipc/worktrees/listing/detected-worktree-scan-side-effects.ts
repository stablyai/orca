import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence/loading-store/store'
import { isLocalWorktreeScanGenerationCurrent } from '../../../local-worktree-scan-generation'
import {
  getRegisteredWorktreeRootsRevision,
  registerWorktreeRootsForRepo
} from '../../registered-worktree-roots-cache'
import { pruneLineageForMissingRepoWorktrees } from '../../../worktree-lineage-pruning'
import { pruneMetadataMissingFromAuthoritativeLocalScan } from './authoritative-local-worktree-metadata-pruning'
import { createCapturedRepoCurrentGuard } from './worktree-host-ownership'
import type { CapturedRepoCurrentGuard } from './worktree-host-ownership'
import type {
  DetectedWorktreeMetadataPrune,
  DetectedWorktreeSideEffectToken
} from './detected-worktree-scan-cache'

export async function applyFreshDetectedWorktreeScanSideEffects(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[],
  metadataPrune?: DetectedWorktreeMetadataPrune,
  options: {
    isCurrent?: () => boolean
    isRepoCurrent?: CapturedRepoCurrentGuard
    sideEffectToken?: DetectedWorktreeSideEffectToken
    signal?: AbortSignal
    /** Undefined means the caller owns no cadence (non-local providers); it keeps the eager behavior. */
    hygieneDue?: boolean
  } = {}
): Promise<boolean> {
  const {
    isCurrent: callerCurrent = () => true,
    sideEffectToken,
    signal,
    hygieneDue = true
  } = options
  const capturedRepo = { ...repo }
  const isRepoCurrent = options.isRepoCurrent ?? createCapturedRepoCurrentGuard(store)
  const isCurrent = () =>
    callerCurrent() && isRepoCurrent(capturedRepo, getRepoExecutionHostId(capturedRepo))
  const generationCurrent = () =>
    sideEffectToken === undefined ||
    isLocalWorktreeScanGenerationCurrent(repo.id, sideEffectToken.generation)
  if (!generationCurrent() || !isCurrent()) {
    return false
  }
  let preservedMetadataCandidateIds: ReadonlySet<string> | undefined
  if (metadataPrune) {
    if (!sideEffectToken) {
      return false
    }
    const pruneResult = await pruneMetadataMissingFromAuthoritativeLocalScan({
      store,
      repo,
      gitWorktrees,
      scan: metadataPrune.expectation,
      scanGeneration: sideEffectToken.generation,
      isCallerCurrent: isCurrent,
      signal
    })
    if (!pruneResult.scanGenerationCurrent || !generationCurrent() || !isCurrent()) {
      return false
    }
    preservedMetadataCandidateIds = pruneResult.preservedMetadataCandidateIds
  }
  if (!generationCurrent() || !isCurrent()) {
    return false
  }

  if (
    sideEffectToken &&
    getRegisteredWorktreeRootsRevision(repo.id) !== sideEffectToken.authorizedRootsRevision
  ) {
    return false
  }
  rememberLocalWorktreeRoots(store, repo, gitWorktrees, sideEffectToken)
  // Why: lineage retention is decided against the metadata rows the prune preserved, so running it
  // without that pass would drop lineage for rows the pass would have kept. Both halves share the
  // hygiene cadence instead.
  if (hygieneDue) {
    pruneLineageForMissingRepoWorktrees(
      store,
      repo,
      gitWorktrees,
      preservedMetadataCandidateIds ? { preservedMetadataCandidateIds } : undefined
    )
  }
  return true
}

export function rememberLocalWorktreeRoots(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[],
  listing: { wslDistro?: string } = {}
): void {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return
  }
  // Why: reuse the `git worktree list` result so later git/file IPC validation skips a second scan that can trigger macOS folder-permission prompts.
  registerWorktreeRootsForRepo(
    store,
    repo,
    [repo.path, ...gitWorktrees.map((worktree) => worktree.path)],
    listing
  )
}
