import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { listRepoWorktrees } from '../../../repo-worktrees'
import {
  getRegisteredWorktreeRootsRevision,
  registerWorktreeRootsForRepo
} from '../../registered-worktree-roots-cache'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../../../persistence/tracking-repos/missing-local-worktree-metadata-pruning'
import {
  bumpLocalWorktreeScanGeneration,
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent,
  resetLocalWorktreeScanGenerationsForTests
} from '../../../local-worktree-scan-generation'
import { pruneLineageForMissingRepoWorktrees } from '../../../worktree-lineage-pruning'
import {
  __resetLocalWorktreeMetadataPruneGateForTests,
  isLocalWorktreeMetadataPruneDue,
  markLocalWorktreeMetadataPruneStarted,
  recordLocalWorktreeListingForPruneGate,
  requireLocalWorktreeMetadataPrune
} from '../../../local-worktree-metadata-prune-gate'
import { pruneMetadataMissingFromAuthoritativeLocalScan } from './authoritative-local-worktree-metadata-pruning'

// Why: absorb renderer polling bursts while bounding external worktree-change lag to one short refresh window.
export const DETECTED_WORKTREE_SCAN_CACHE_TTL_MS = 5_000

export type DetectedWorktreeScanCacheEntry = {
  expiresAt: number
  worktrees: GitWorktreeInfo[]
}

export type DetectedWorktreeScan = {
  invalidated: boolean
  promise: Promise<GitWorktreeInfo[]>
  sideEffectToken: DetectedWorktreeSideEffectToken
  hygieneDue: boolean
  metadataPrune?: DetectedWorktreeMetadataPrune
}

export type DetectedWorktreeSideEffectToken = Readonly<{
  generation: number
  authorizedRootsRevision: number
}>

export type DetectedWorktreeMetadataPrune = Readonly<{
  expectation: NativeLocalWorktreeMetadataScanExpectation
}>

export type DetectedWorktreeScanResult = {
  gitWorktrees: GitWorktreeInfo[]
  fresh: boolean
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
  repo: Repo
): Promise<DetectedWorktreeScanResult> {
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  if (repo.connectionId || isFolderRepo(repo)) {
    return {
      gitWorktrees: await listRepoWorktrees(repo, localWorktreeGitOptions),
      fresh: true
    }
  }

  const cacheKey = getDetectedWorktreeScanCacheKey(repo.id, localWorktreeGitOptions)
  const cached = detectedWorktreeScanCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { gitWorktrees: cached.worktrees, fresh: false }
  }

  const inFlight = detectedWorktreeScanInFlight.get(cacheKey)
  if (inFlight) {
    return { gitWorktrees: await inFlight.promise, fresh: false }
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
    invalidated: false,
    promise: listRepoWorktrees(repo, localWorktreeGitOptions),
    sideEffectToken: { generation, authorizedRootsRevision },
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
    recordLocalWorktreeListingForPruneGate(
      repo.id,
      gitWorktrees.map((worktree) => worktree.path)
    )
    const routingUnchanged =
      getDetectedWorktreeScanCacheKey(repo.id, getLocalProjectWorktreeGitOptions(store, repo)) ===
      cacheKey
    // Why: a create/remove notification can invalidate mid-scan; don't let that stale scan repopulate the cache afterward.
    const generationCurrent = isLocalWorktreeScanGenerationCurrent(repo.id, generation)
    if (!scan.invalidated && routingUnchanged && generationCurrent) {
      detectedWorktreeScanCache.set(cacheKey, {
        worktrees: gitWorktrees,
        expiresAt: Date.now() + DETECTED_WORKTREE_SCAN_CACHE_TTL_MS
      })
    }
    const fresh = !scan.invalidated && routingUnchanged && generationCurrent
    return {
      gitWorktrees,
      fresh,
      ...(fresh ? { sideEffectToken: scan.sideEffectToken, hygieneDue: scan.hygieneDue } : {}),
      ...(fresh && scan.metadataPrune ? { metadataPrune: scan.metadataPrune } : {})
    }
  } finally {
    if (detectedWorktreeScanInFlight.get(cacheKey) === scan) {
      detectedWorktreeScanInFlight.delete(cacheKey)
    }
  }
}

export async function applyFreshDetectedWorktreeScanSideEffects(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[],
  metadataPrune?: DetectedWorktreeMetadataPrune,
  options: {
    isCurrent?: () => boolean
    sideEffectToken?: DetectedWorktreeSideEffectToken
    signal?: AbortSignal
    /** Undefined means the caller owns no cadence (non-local providers); it keeps the eager behavior. */
    hygieneDue?: boolean
  } = {}
): Promise<boolean> {
  const { isCurrent = () => true, sideEffectToken, signal, hygieneDue = true } = options
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
  rememberLocalWorktreeRoots(store, repo, gitWorktrees)
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

export function getDetectedWorktreeScanCacheKey(
  repoId: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): string {
  return `${repoId}\0${localWorktreeGitOptions.wslDistro ?? 'host'}`
}

export function rememberLocalWorktreeRoots(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): void {
  if (repo.connectionId) {
    return
  }
  // Why: reuse the `git worktree list` result so later git/file IPC validation skips a second scan that can trigger macOS folder-permission prompts.
  registerWorktreeRootsForRepo(store, repo.id, [
    repo.path,
    ...gitWorktrees.map((worktree) => worktree.path)
  ])
}
