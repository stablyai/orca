import type { RuntimeWorktreeScanCache } from './runtime-worktree-scan-state'
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

export type RuntimeWorktreeListingOptions = {
  captureMetadataPruneExpectation?: boolean
}

export type WitnessedRuntimeWorktreeScan = RuntimeWorktreeScanAttempt & {
  /** A concurrent worktree change made these scan rows stale. */
  superseded: boolean
  isCurrent: () => boolean
  scanGeneration: number
  metadataPruneExpectation: NativeLocalWorktreeMetadataScanExpectation | undefined
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
  const scanGeneration = getLocalWorktreeScanGeneration(repo.id)
  const ownerIsCurrent = captureRuntimeWorktreeScanOwner(store, repo)
  const metadataPruneExpectation = captureMetadataPruneExpectation
    ? captureLocalMetadataPruneExpectation(store, repo)
    : undefined
  let scan: RuntimeWorktreeScanAttempt
  try {
    scan = await scanRepo(repo)
  } catch {
    scan = { ok: false, worktrees: [] }
  }
  const innerIsCurrent = scan.isCurrent
  const superseded =
    scan.superseded === true ||
    !ownerIsCurrent() ||
    (innerIsCurrent !== undefined && !innerIsCurrent())
  return {
    ...scan,
    superseded,
    isCurrent: () => !superseded && ownerIsCurrent() && (!innerIsCurrent || innerIsCurrent()),
    scanGeneration,
    metadataPruneExpectation
  }
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
  cache: Map<string, RuntimeWorktreeScanCache>
  generations: ReadonlyMap<string, number>
  isCurrentRuntime: () => boolean
  options?: RuntimeWorktreeListingOptions
}): Promise<WitnessedRuntimeWorktreeScan> {
  const { store, repo } = deps
  let initialAttempt = true
  let listingCache: RuntimeWorktreeScanCache | undefined
  let listingIsCurrent: () => boolean = () => false
  const scan = await scanRuntimeWorktreesUntilNotOvertaken(
    store,
    repo,
    async (current) => {
      const ownerIsCurrent = captureRuntimeWorktreeScanOwner(store, current)
      const key = `${current.id}\0${getRepoExecutionHostId(current)}`
      const generation = deps.generations.get(key) ?? 0
      listingIsCurrent = () =>
        deps.isCurrentRuntime() &&
        ownerIsCurrent() &&
        (deps.generations.get(key) ?? 0) === generation
      const firstAttempt = initialAttempt
      initialAttempt = false
      listingCache = undefined
      const raw = await deps.scanRepo(current, firstAttempt)
      if (raw.superseded) {
        return raw
      }
      const entry = deps.cache.get(key)
      const resolutionIsCurrent = listingIsCurrent
      listingIsCurrent = () => resolutionIsCurrent() && deps.cache.get(key) === entry
      const worktrees = preserveFolderUpgradeWorktreePath(current, raw.worktrees)
      const listing: RuntimeWorktreeScanAttempt =
        raw.ok && getRepoExecutionHostId(current) === LOCAL_EXECUTION_HOST_ID
          ? {
              ok: true,
              worktrees: await withUnregisteredRemovalCheckouts(
                current.id,
                withoutInFlightWorktreeCreates(current.id, worktrees)
              )
            }
          : { ...raw, worktrees }
      if (!listingIsCurrent()) {
        return { ok: false, worktrees: [], superseded: true }
      }
      listingCache = entry?.result === raw ? entry : undefined
      return listing
    },
    deps.options
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
  if (witnessed.ok && listingCache) {
    listingCache.listing = { ...witnessed, metadataPruneExpectation: undefined }
  }
  return witnessed
}
