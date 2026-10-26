import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { listRepoWorktreesForDetectedScan } from '../../../repo-worktrees'
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

// Coalesce renderer polls while bounding external-change lag.
export const DETECTED_WORKTREE_SCAN_CACHE_TTL_MS = 5_000

export type DetectedWorktreeScanCacheEntry = {
  expiresAt: number
  worktrees: GitWorktreeInfo[]
  /** Scan-start generation, used to order these cached rows. */
  generation: number
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
  wslDistro?: string
}>

export type DetectedWorktreeMetadataPrune = Readonly<{
  expectation: NativeLocalWorktreeMetadataScanExpectation
}>

export type DetectedWorktreeScanResult = {
  gitWorktrees: GitWorktreeInfo[]
  fresh: boolean
  /** Mutation overtook this scan; publishing its missing rows as authoritative would falsely delete new worktrees. */
  superseded: boolean
  generation: number
  sideEffectToken?: DetectedWorktreeSideEffectToken
  /** Owns the next store-hygiene pass; absent preserves eager behavior for non-local scans. */
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
      // Detached scans retain invalidation so later completions cannot make them fresh again.
      inFlight.invalidated = true
      detectedWorktreeScanInFlight.delete(key)
    }
  }
}

export function __resetDetectedWorktreeScanCacheForTests(): void {
  // Pending scans must remain invalidated across resets to prevent cache leaks into later tests.
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
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID || isFolderRepo(repo)) {
    const generation = getLocalWorktreeScanGeneration(repo.id)
    return {
      gitWorktrees: await listRepoWorktreesForDetectedScan(repo, localWorktreeGitOptions),
      fresh: true,
      superseded: false,
      generation
    }
  }

  const cacheKey = getDetectedWorktreeScanCacheKey(repo.id, localWorktreeGitOptions)
  const cached = detectedWorktreeScanCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return {
      gitWorktrees: cached.worktrees,
      fresh: false,
      superseded: false,
      generation: cached.generation
    }
  }

  const inFlight = detectedWorktreeScanInFlight.get(cacheKey)
  if (inFlight) {
    const gitWorktrees = await inFlight.promise
    return {
      gitWorktrees,
      fresh: false,
      superseded:
        inFlight.invalidated ||
        !isLocalWorktreeScanGenerationCurrent(repo.id, inFlight.sideEffectToken.generation),
      generation: inFlight.sideEffectToken.generation
    }
  }

  // Capture before Git can yield or mutate synchronously; WSL/UNC aliases cannot establish native destructive expectations.
  const generation = getLocalWorktreeScanGeneration(repo.id)
  const authorizedRootsRevision = getRegisteredWorktreeRootsRevision(repo.id)
  // Whole-table capture and missing-path stats run only when changed evidence makes hygiene due (#17775).
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
    // Changed listings invalidate hygiene conclusions even when native events were lost.
    recordLocalWorktreeListingForPruneGate(
      repo.id,
      gitWorktrees.map((worktree) => worktree.path)
    )
    const routingUnchanged =
      getDetectedWorktreeScanCacheKey(repo.id, getLocalProjectWorktreeGitOptions(store, repo)) ===
      cacheKey
    // Mid-scan mutations must prevent stale cache publication.
    const generationCurrent = isLocalWorktreeScanGenerationCurrent(repo.id, generation)
    if (!scan.invalidated && routingUnchanged && generationCurrent) {
      detectedWorktreeScanCache.set(cacheKey, {
        worktrees: gitWorktrees,
        expiresAt: Date.now() + DETECTED_WORKTREE_SCAN_CACHE_TTL_MS,
        generation
      })
    }
    const fresh = !scan.invalidated && routingUnchanged && generationCurrent
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

export async function applyFreshDetectedWorktreeScanSideEffects(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[],
  metadataPrune?: DetectedWorktreeMetadataPrune,
  options: {
    isCurrent?: () => boolean
    sideEffectToken?: DetectedWorktreeSideEffectToken
    signal?: AbortSignal
    /** Non-local callers have no hygiene cadence and keep eager behavior. */
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
  rememberLocalWorktreeRoots(store, repo, gitWorktrees, sideEffectToken)
  // Lineage depends on metadata retention decisions; both pruning passes must share the hygiene cadence.
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
  gitWorktrees: GitWorktreeInfo[],
  listing: { wslDistro?: string } = {}
): void {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return
  }
  // Reuse listing roots for authorization to avoid another Git scan and macOS folder-permission prompts.
  registerWorktreeRootsForRepo(
    store,
    repo,
    [repo.path, ...gitWorktrees.map((worktree) => worktree.path)],
    listing
  )
}
