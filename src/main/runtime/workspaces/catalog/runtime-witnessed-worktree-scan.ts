import {
  listStoredWorktreeRowsForRepo,
  type RuntimeWorktreeScanAttempt
} from './repo-worktree-resolution-scan'
import { withUnregisteredRemovalCheckouts } from '../../../workspaces/removal/worktree-removal-listing'
import { withoutInFlightWorktreeCreates } from '../../../workspaces/creation/worktree-create-in-flight'
import { preserveFolderUpgradeWorktreePath } from '../../../workspaces/catalog/folder-upgrade-worktree-path'
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
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import { getRepoKind } from '../../../../shared/repo-kind'
import { getProjectHostSetupForRepo } from '../../../../shared/project-host-setup-lookup'
import { resolveWorktreeScanRuntime } from './runtime-worktree-scan-cache'
import {
  claimRuntimeLineagePrune,
  observationForRuntimeResult,
  rememberRuntimeWorktreeListing,
  runtimeResultForObservation
} from './runtime-worktree-catalog-read'
import { isCurrentWorktreeCatalogObservation } from '../../../workspaces/catalog/repo-worktree-catalog-owner'
import { claimWorktreeCatalogHygiene } from '../../../ipc/worktrees/listing/worktree-catalog-observation-hygiene'

export type RuntimeWorktreeListingOptions = {
  captureMetadataPruneExpectation?: boolean
}

export type WitnessedRuntimeWorktreeScan = RuntimeWorktreeScanAttempt & {
  /** A concurrent worktree change made these scan rows stale. */
  superseded: boolean
  isCurrent: () => boolean
  scanGeneration: number
  metadataPruneExpectation: NativeLocalWorktreeMetadataScanExpectation | undefined
  /** Lineage prunes once per observation; null when another read of these rows already did. */
  lineagePrune: { scanGeneration: number } | null
  /** Owner authority for these rows, rechecked after awaits before destructive work. */
  authorityCurrent: () => boolean
}

export function currentRuntimeWorktreeScanRepo(store: Pick<RuntimeStore, 'getRepos'>, repo: Repo) {
  const owners = store
    .getRepos()
    .filter(
      (candidate) =>
        candidate.id === repo.id &&
        getRepoExecutionHostId(candidate) === getRepoExecutionHostId(repo)
    )
  return owners.length === 1 ? owners[0] : undefined
}

export function runtimeWorktreeScanOwnerKey(store: RuntimeStore, repo: Repo): string {
  const setup = getProjectHostSetupForRepo(store.getProjectHostSetups?.() ?? [], repo)
  return JSON.stringify([
    repo.path,
    getRepoKind(repo),
    getRepoRoutingConnectionId(repo),
    repo.executionHostId ?? null,
    setup.id,
    setup.projectId,
    setup.hostId,
    setup.repoId,
    setup.path,
    getRepoKind(setup),
    resolveWorktreeScanRuntime(store, repo).runtimeKey
  ])
}

/** Capture only execution identity; cached reads must not snapshot the metadata cohort again. */
export function captureRuntimeWorktreeScanOwner(store: RuntimeStore, repo: Repo): () => boolean {
  repo = { ...repo }
  const generation = getLocalWorktreeScanGeneration(repo.id)
  const capturedAddress = runtimeWorktreeScanOwnerKey(store, repo)
  return () => {
    const current = currentRuntimeWorktreeScanRepo(store, repo)
    return (
      !!current &&
      isLocalWorktreeScanGenerationCurrent(repo.id, generation) &&
      runtimeWorktreeScanOwnerKey(store, current) === capturedAddress
    )
  }
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
  scanRepo: (repo: Repo) => Promise<RuntimeWorktreeScanAttempt>,
  captureMetadataPruneExpectation: boolean
): Promise<WitnessedRuntimeWorktreeScan> {
  // Capture before listing can mutate metadata synchronously; pruning revalidates the original rows.
  let scanGeneration = getLocalWorktreeScanGeneration(repo.id)
  const ownerIsCurrent = captureRuntimeWorktreeScanOwner(store, repo)
  const injectedExpectation = captureMetadataPruneExpectation
    ? captureLocalMetadataPruneExpectation(store, repo)
    : undefined
  let metadataPruneExpectation: NativeLocalWorktreeMetadataScanExpectation | undefined
  let lineagePrune: { scanGeneration: number } | null = null
  let authorityCurrent = (): boolean => true
  let scan: RuntimeWorktreeScanAttempt
  try {
    scan = await scanRepo(repo)
  } catch {
    scan = { ok: false, worktrees: [] }
  }
  const observation = observationForRuntimeResult(scan)
  if (observation) {
    // Only the actual flight's pre-scan claim can authorize destructive work on these rows.
    scanGeneration = observation.generation
    authorityCurrent = () => isCurrentWorktreeCatalogObservation(observation)
    const claim =
      captureMetadataPruneExpectation && ownerIsCurrent() && authorityCurrent()
        ? claimWorktreeCatalogHygiene(observation)
        : null
    metadataPruneExpectation = claim?.expectation
    lineagePrune = captureMetadataPruneExpectation ? claimRuntimeLineagePrune(scan) : null
  } else {
    metadataPruneExpectation = injectedExpectation
    lineagePrune = { scanGeneration }
  }
  const innerIsCurrent = scan.isCurrent
  const superseded =
    scan.superseded === true ||
    !ownerIsCurrent() ||
    (innerIsCurrent !== undefined && !innerIsCurrent()) ||
    (scan.ok && !authorityCurrent())
  const witnessed: WitnessedRuntimeWorktreeScan = {
    ...scan,
    superseded,
    isCurrent: () =>
      !superseded &&
      ownerIsCurrent() &&
      (!innerIsCurrent || innerIsCurrent()) &&
      (!scan.ok || authorityCurrent()),
    scanGeneration,
    metadataPruneExpectation,
    lineagePrune,
    authorityCurrent
  }
  rememberRuntimeWorktreeListing(scan, witnessed)
  return witnessed
}

/** Rerun overtaken scans within the shared retry bound. */
export function scanRuntimeWorktreesUntilNotOvertaken(
  store: RuntimeStore,
  repo: Repo,
  scanRepo: (repo: Repo) => Promise<RuntimeWorktreeScanAttempt>,
  options: RuntimeWorktreeListingOptions = {}
): Promise<WitnessedRuntimeWorktreeScan> {
  repo = { ...repo }
  return scanUntilNotOvertaken(
    repo.id,
    () => {
      const current = currentRuntimeWorktreeScanRepo(store, repo)
      return scanRuntimeWorktreesWithMutationWitness(
        store,
        { ...(current ?? repo) },
        current ? scanRepo : () => Promise.resolve({ ok: false, worktrees: [], superseded: true }),
        !!current && options.captureMetadataPruneExpectation === true
      )
    },
    () => !!currentRuntimeWorktreeScanRepo(store, repo)
  )
}

export async function listRuntimeRepoWorktreesForListing(deps: {
  store: RuntimeStore
  repo: Repo
  scanRepo: (repo: Repo, initialAttempt: boolean) => Promise<RuntimeWorktreeScanAttempt>
  isCurrentRuntime: () => boolean
  options?: RuntimeWorktreeListingOptions
}): Promise<WitnessedRuntimeWorktreeScan> {
  const { store, repo } = deps
  let initialAttempt = true
  let listingIsCurrent: () => boolean = () => false
  const scan = await scanRuntimeWorktreesUntilNotOvertaken(
    store,
    repo,
    async (current) => {
      const ownerIsCurrent = captureRuntimeWorktreeScanOwner(store, current)
      const firstAttempt = initialAttempt
      initialAttempt = false
      const result = await deps.scanRepo(current, firstAttempt)
      const observation = observationForRuntimeResult(result)
      listingIsCurrent = () =>
        deps.isCurrentRuntime() &&
        ownerIsCurrent() &&
        (!result.isCurrent || result.isCurrent()) &&
        (!result.ok || !observation || isCurrentWorktreeCatalogObservation(observation))
      if (result.superseded) {
        return result
      }
      const worktrees = preserveFolderUpgradeWorktreePath(current, result.worktrees)
      const listing: RuntimeWorktreeScanAttempt =
        result.ok && getRepoExecutionHostId(current) === LOCAL_EXECUTION_HOST_ID
          ? {
              ...result,
              worktrees: await withUnregisteredRemovalCheckouts(
                current.id,
                withoutInFlightWorktreeCreates(current.id, worktrees)
              )
            }
          : { ...result, worktrees }
      if (!listingIsCurrent()) {
        return { ok: false, worktrees: [], superseded: true }
      }
      rememberRuntimeWorktreeListing(result, listing)
      return listing
    },
    {}
  )
  const scanIsCurrent = scan.isCurrent
  const witnessed = { ...scan, isCurrent: () => scanIsCurrent() && listingIsCurrent() }
  if (witnessed.superseded || !witnessed.isCurrent()) {
    const current = currentRuntimeWorktreeScanRepo(store, repo)
    return {
      ...witnessed,
      ok: false,
      superseded: true,
      worktrees: current ? listStoredWorktreeRowsForRepo(store, current) : []
    }
  }
  const observation = observationForRuntimeResult(scan)
  if (observation && witnessed.ok) {
    const raw = runtimeResultForObservation(observation)
    if (deps.options?.captureMetadataPruneExpectation && witnessed.isCurrent()) {
      witnessed.metadataPruneExpectation = claimWorktreeCatalogHygiene(observation)?.expectation
      witnessed.lineagePrune = claimRuntimeLineagePrune(raw)
    }
    // Cached delivery retains the observation identity, never an already-consumed destructive claim.
    const cached = { ...witnessed, metadataPruneExpectation: undefined }
    rememberRuntimeWorktreeListing(raw, cached)
    rememberRuntimeWorktreeListing(cached, witnessed)
  }
  return witnessed
}
