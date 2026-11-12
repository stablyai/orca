import type { Repo } from '../../../../shared/repo-types'
import { scanUntilNotOvertaken } from '../../../ipc/worktrees/listing/overtaken-scan-rerun'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../../../persistence/tracking-repos/local-worktree-metadata-scan-expectation'
import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from '../../../workspaces/catalog/local-worktree-scan-generation'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import type { Store } from '../../../persistence/loading-store/store'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import {
  claimRuntimeLineagePrune,
  observationForRuntimeResult
} from './runtime-worktree-catalog-read'
import { isCurrentWorktreeCatalogObservation } from '../../../workspaces/catalog/repo-worktree-catalog-owner'
import { claimWorktreeCatalogHygiene } from '../../../ipc/worktrees/listing/worktree-catalog-observation-hygiene'

export type WitnessedRuntimeWorktreeScan = RuntimeWorktreeScanResult & {
  /** A concurrent worktree change made these scan rows stale. */
  superseded: boolean
  scanGeneration: number
  metadataPruneExpectation: NativeLocalWorktreeMetadataScanExpectation | undefined
  /** Lineage prunes once per observation; null when another read of these rows already did. */
  lineagePrune: { scanGeneration: number } | null
  /** Owner authority for these rows, rechecked after awaits before destructive work. */
  authorityCurrent: () => boolean
}

/** Refuse destructive pruning on unresolved routes or WSL, whose Linux paths v1 cannot equate with stored UNC aliases. */
function captureLocalMetadataPruneExpectation(
  store: RuntimeStore,
  repo: Repo
): NativeLocalWorktreeMetadataScanExpectation | undefined {
  if (typeof store.captureNativeLocalWorktreeMetadataScanExpectation !== 'function') {
    return undefined
  }
  try {
    if (getLocalProjectWorktreeGitOptions(store as unknown as Store, repo).wslDistro) {
      return undefined
    }
  } catch {
    return undefined
  }
  return store.captureNativeLocalWorktreeMetadataScanExpectation(repo)
}

// Desktop and headless invalidators share this generation and clear the runtime scan cache, so retries list afresh.
async function scanRuntimeWorktreesWithMutationWitness(
  store: RuntimeStore,
  repo: Repo,
  scanRepo: (repo: Repo) => Promise<RuntimeWorktreeScanResult>
): Promise<WitnessedRuntimeWorktreeScan> {
  // Capture before listing can mutate metadata synchronously; pruning revalidates the original rows.
  let scanGeneration = getLocalWorktreeScanGeneration(repo.id)
  let metadataPruneExpectation: NativeLocalWorktreeMetadataScanExpectation | undefined
  let lineagePrune: { scanGeneration: number } | null = null
  let authorityCurrent = (): boolean => true
  let scan: RuntimeWorktreeScanResult
  try {
    scan = await scanRepo(repo)
  } catch {
    scan = { ok: false, worktrees: [] }
  }
  const observation = observationForRuntimeResult(scan)
  if (observation) {
    // Shared observations carry their own pre-scan witness; older rows never get today's expectations.
    scanGeneration = observation.generation
    authorityCurrent = () => isCurrentWorktreeCatalogObservation(observation)
    const claim =
      isLocalWorktreeScanGenerationCurrent(repo.id, scanGeneration) && authorityCurrent()
        ? claimWorktreeCatalogHygiene(observation)
        : null
    metadataPruneExpectation = claim?.expectation
    lineagePrune = claimRuntimeLineagePrune(scan)
  } else {
    metadataPruneExpectation = captureLocalMetadataPruneExpectation(store, repo)
    lineagePrune = { scanGeneration }
  }
  return {
    ...scan,
    // Failed scans are already non-authoritative.
    superseded:
      scan.ok &&
      (!isLocalWorktreeScanGenerationCurrent(repo.id, scanGeneration) || !authorityCurrent()),
    scanGeneration,
    metadataPruneExpectation,
    lineagePrune,
    authorityCurrent
  }
}

/** Rerun overtaken scans within the shared retry bound. */
export function scanRuntimeWorktreesUntilNotOvertaken(
  store: RuntimeStore,
  repo: Repo,
  scanRepo: (repo: Repo) => Promise<RuntimeWorktreeScanResult>
): Promise<WitnessedRuntimeWorktreeScan> {
  return scanUntilNotOvertaken(
    repo.id,
    () => scanRuntimeWorktreesWithMutationWitness(store, repo, scanRepo),
    () => true
  )
}
