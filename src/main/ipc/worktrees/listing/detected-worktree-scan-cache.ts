import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { listRepoWorktreesForDetectedScan } from '../../../repo-worktrees'
import { getRegisteredWorktreeRootsRevision } from '../../registered-worktree-roots-cache'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../../../persistence/tracking-repos/missing-local-worktree-metadata-pruning'
import {
  bumpLocalWorktreeScanGeneration,
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent,
  resetLocalWorktreeScanGenerationsForTests
} from '../../../local-worktree-scan-generation'
import {
  __resetLocalWorktreeMetadataPruneGateForTests,
  isLocalWorktreeMetadataPruneDue,
  markLocalWorktreeMetadataPruneStarted,
  recordLocalWorktreeListingForPruneGate,
  requireLocalWorktreeMetadataPrune
} from '../../../local-worktree-metadata-prune-gate'
import {
  createCapturedRepoCurrentGuard,
  type CapturedRepoCurrentGuard
} from './worktree-host-ownership'

// Why: absorb renderer polling bursts while bounding external worktree-change lag to one short refresh window.
export const DETECTED_WORKTREE_SCAN_CACHE_TTL_MS = 5_000

export type DetectedWorktreeScanCacheEntry = {
  repo: Repo
  expiresAt: number
  worktrees: GitWorktreeInfo[]
  /** The generation the cached scan began at: the catalog its rows describe. */
  generation: number
}

export type DetectedWorktreeScan = {
  repo: Repo
  invalidated: boolean
  promise: Promise<GitWorktreeInfo[]>
  sideEffectToken: DetectedWorktreeSideEffectToken
  hygieneDue: boolean
  metadataPrune?: DetectedWorktreeMetadataPrune
}

export type DetectedWorktreeSideEffectToken = Readonly<{
  generation: number
  authorizedRootsRevision: number
  /** The distro whose Git listed the scan; undefined is host Git. */
  wslDistro?: string
}>

export type DetectedWorktreeMetadataPrune = Readonly<{
  expectation: NativeLocalWorktreeMetadataScanExpectation
}>

export type DetectedWorktreeScanResult = {
  gitWorktrees: GitWorktreeInfo[]
  fresh: boolean
  /**
   * The scan ran, but a worktree mutation invalidated it before it settled (or it joined such a
   * scan). Its rows describe a catalog that no longer exists: they must not be published as
   * authoritative, because a worktree added during the scan reads as absent, i.e. deleted.
   */
  superseded: boolean
  /** The repo's scan generation when this scan began; the catalog version its rows describe. */
  generation: number
  sideEffectToken?: DetectedWorktreeSideEffectToken
  /** Whether this scan owns the repo's next store-hygiene pass; absent means "not from a local scan". */
  hygieneDue?: boolean
  metadataPrune?: DetectedWorktreeMetadataPrune
}

export const detectedWorktreeScanCache = new Map<string, DetectedWorktreeScanCacheEntry>()
export const detectedWorktreeScanInFlight = new Map<string, DetectedWorktreeScan>()

export function invalidateDetectedWorktreeScanCache(repoId: string): void {
  bumpLocalWorktreeScanGeneration(repoId)
  requireLocalWorktreeMetadataPrune(repoId)
  const keyPrefix = `${repoId}\0`
  for (const key of new Set([
    ...detectedWorktreeScanCache.keys(),
    ...detectedWorktreeScanInFlight.keys()
  ])) {
    if (!key.startsWith(keyPrefix)) {
      continue
    }
    detectedWorktreeScanCache.delete(key)
    const inFlight = detectedWorktreeScanInFlight.get(key)
    if (inFlight) {
      // Why: the detached scan keeps this token so later scans settle without making an older result fresh again.
      inFlight.invalidated = true
      detectedWorktreeScanInFlight.delete(key)
    }
  }
}

export function __resetDetectedWorktreeScanCacheForTests(): void {
  // Why: pending scans across a test reset must not repopulate the cache and leak state into the next test.
  for (const scan of detectedWorktreeScanInFlight.values()) {
    scan.invalidated = true
  }
  detectedWorktreeScanCache.clear()
  detectedWorktreeScanInFlight.clear()
  resetLocalWorktreeScanGenerationsForTests()
  __resetLocalWorktreeMetadataPruneGateForTests()
}

export function __getDetectedWorktreeScanCacheStatsForTests(): {
  cacheSize: number
  inFlightSize: number
} {
  return {
    cacheSize: detectedWorktreeScanCache.size,
    inFlightSize: detectedWorktreeScanInFlight.size
  }
}

export async function listDetectedGitWorktrees(
  store: Store,
  repo: Repo,
  isRepoCurrent: CapturedRepoCurrentGuard = createCapturedRepoCurrentGuard(store)
): Promise<DetectedWorktreeScanResult> {
  const capturedRepo = { ...repo }
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  if (
    parseExecutionHostId(getRepoExecutionHostId(repo))?.kind === 'runtime' &&
    !isFolderRepo(repo)
  ) {
    // Preserve the routing rejection before a contradictory row is classified as stale.
    await listRepoWorktreesForDetectedScan(repo, localWorktreeGitOptions)
  }
  const isCurrent = () => isRepoCurrent(capturedRepo, getRepoExecutionHostId(capturedRepo))
  if (!isCurrent()) {
    return {
      gitWorktrees: [],
      fresh: false,
      superseded: true,
      generation: getLocalWorktreeScanGeneration(repo.id)
    }
  }
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID || isFolderRepo(repo)) {
    const generation = getLocalWorktreeScanGeneration(repo.id)
    const gitWorktrees = await listRepoWorktreesForDetectedScan(repo, localWorktreeGitOptions)
    const fresh = isCurrent()
    return {
      gitWorktrees,
      fresh,
      superseded: !fresh,
      generation
    }
  }

  const cacheKey = getDetectedWorktreeScanCacheKey(repo.id, localWorktreeGitOptions)
  const cached = detectedWorktreeScanCache.get(cacheKey)
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    isRepoCurrent(cached.repo, getRepoExecutionHostId(capturedRepo))
  ) {
    return {
      gitWorktrees: cached.worktrees,
      fresh: false,
      superseded: false,
      generation: cached.generation
    }
  }

  const inFlight = detectedWorktreeScanInFlight.get(cacheKey)
  if (inFlight && isRepoCurrent(inFlight.repo, getRepoExecutionHostId(capturedRepo))) {
    const gitWorktrees = await inFlight.promise
    // Why: a joiner inherits the scan's staleness, not just its rows.
    return {
      gitWorktrees,
      fresh: false,
      superseded:
        !isCurrent() ||
        inFlight.invalidated ||
        !isLocalWorktreeScanGenerationCurrent(repo.id, inFlight.sideEffectToken.generation),
      generation: inFlight.sideEffectToken.generation
    }
  }

  // Why: capture before invoking Git because listing can mutate synchronously before its first await.
  // WSL listings can use UNC paths while legacy metadata keeps Linux paths; v1 cannot prove
  // those aliases equivalent, so only native-host scans carry destructive expectations.
  const generation = getLocalWorktreeScanGeneration(repo.id)
  const authorizedRootsRevision = getRegisteredWorktreeRootsRevision(repo.id)
  // Why: capturing the expectation walks the repo's whole metadata table and the prune that follows
  // stats every path-missing row, so both run only against evidence that the answer changed (#17775).
  const hygieneDue = isLocalWorktreeMetadataPruneDue(repo.id)
  if (hygieneDue) {
    markLocalWorktreeMetadataPruneStarted(repo.id)
  }
  const metadataPruneExpectation =
    hygieneDue && !localWorktreeGitOptions.wslDistro
      ? store.captureNativeLocalWorktreeMetadataScanExpectation(repo)
      : undefined
  const scan: DetectedWorktreeScan = {
    repo: capturedRepo,
    invalidated: false,
    promise: listRepoWorktreesForDetectedScan(repo, localWorktreeGitOptions),
    sideEffectToken: { generation, authorizedRootsRevision, ...localWorktreeGitOptions },
    hygieneDue,
    ...(metadataPruneExpectation
      ? {
          metadataPrune: {
            expectation: metadataPruneExpectation
          }
        }
      : {})
  }
  detectedWorktreeScanInFlight.set(cacheKey, scan)
  try {
    const gitWorktrees = await scan.promise
    // Why: the backstop signal. A listing that no longer matches the one the last pass ran against
    // invalidates its conclusions even when no event reported the change.
    const routingUnchanged =
      getDetectedWorktreeScanCacheKey(repo.id, getLocalProjectWorktreeGitOptions(store, repo)) ===
      cacheKey
    // Why: a create/remove notification can invalidate mid-scan; don't let that stale scan repopulate the cache afterward.
    const generationCurrent = isLocalWorktreeScanGenerationCurrent(repo.id, generation)
    const fresh = !scan.invalidated && routingUnchanged && generationCurrent && isCurrent()
    if (fresh) {
      recordLocalWorktreeListingForPruneGate(
        repo.id,
        gitWorktrees.map((worktree) => worktree.path)
      )
      detectedWorktreeScanCache.set(cacheKey, {
        repo: capturedRepo,
        worktrees: gitWorktrees,
        expiresAt: Date.now() + DETECTED_WORKTREE_SCAN_CACHE_TTL_MS,
        generation
      })
    }
    return {
      gitWorktrees,
      fresh,
      superseded: !fresh,
      generation,
      ...(fresh ? { sideEffectToken: scan.sideEffectToken, hygieneDue: scan.hygieneDue } : {}),
      ...(fresh && scan.metadataPrune ? { metadataPrune: scan.metadataPrune } : {})
    }
  } finally {
    if (detectedWorktreeScanInFlight.get(cacheKey) === scan) {
      detectedWorktreeScanInFlight.delete(cacheKey)
    }
  }
}

export function getDetectedWorktreeScanCacheKey(
  repoId: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): string {
  return `${repoId}\0${localWorktreeGitOptions.wslDistro ?? 'host'}`
}

export {
  applyFreshDetectedWorktreeScanSideEffects,
  rememberLocalWorktreeRoots
} from './detected-worktree-scan-side-effects'
