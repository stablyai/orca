import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { listRepoWorktreesForDetectedScan } from '../../../workspaces/catalog/repo-worktrees'
import {
  getRegisteredWorktreeRootsRevision,
  registerWorktreeRootsForRepo
} from '../removal/registered-worktree-roots-cache'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../../../persistence/tracking-repos/missing-local-worktree-metadata-pruning'
import {
  bumpLocalWorktreeScanGeneration,
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent,
  resetLocalWorktreeScanGenerationsForTests
} from '../../../workspaces/catalog/local-worktree-scan-generation'
import { pruneLineageForMissingRepoWorktrees } from '../../../workspaces/catalog/worktree-lineage-pruning'
import {
  __resetLocalWorktreeMetadataPruneGateForTests,
  requireLocalWorktreeMetadataPrune
} from '../../../workspaces/catalog/local-worktree-metadata-prune-gate'
import { pruneMetadataMissingFromAuthoritativeLocalScan } from './authoritative-local-worktree-metadata-pruning'
import {
  assertWslUncPathRunning,
  wslDistroForPath
} from '../../../wsl/filesystem/wsl-unc-access-gate'
import {
  _resetWorktreeCatalogOwnerForTests,
  invalidateWorktreeCatalogForRepo,
  readWorktreeCatalog
} from '../../../workspaces/catalog/repo-worktree-catalog-owner'
import { resolveWorktreeScanRuntime } from '../../../runtime/workspaces/catalog/runtime-worktree-scan-cache'
import {
  claimWorktreeCatalogHygiene,
  needsWorktreeCatalogHygieneClaim,
  worktreeCatalogHygienePlan
} from './worktree-catalog-observation-hygiene'

// The sidebar accepts an observation up to this old; fresher demand refreshes the shared owner.
export const DETECTED_WORKTREE_SCAN_CACHE_TTL_MS = 5_000

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

export function invalidateDetectedWorktreeScanCache(repoId: string): void {
  bumpLocalWorktreeScanGeneration(repoId)
  requireLocalWorktreeMetadataPrune(repoId)
  invalidateWorktreeCatalogForRepo(repoId)
}

export function __resetDetectedWorktreeScanCacheForTests(): void {
  _resetWorktreeCatalogOwnerForTests()
  resetLocalWorktreeScanGenerationsForTests()
  __resetLocalWorktreeMetadataPruneGateForTests()
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
  // Git options, runtime key and hygiene all come from one admitted route snapshot.
  const runtimeKey = resolveWorktreeScanRuntime(store, repo).runtimeKey
  // A stopped distro fails as unavailable (rows are retained) instead of booting it (E9); host scans keep their ticks.
  if (wslDistroForPath(repo.path, localWorktreeGitOptions.wslDistro)) {
    await assertWslUncPathRunning(repo.path, localWorktreeGitOptions.wslDistro)
    if (
      resolveWorktreeScanRuntime(store, repo).runtimeKey !== runtimeKey ||
      getLocalProjectWorktreeGitOptions(store, repo).wslDistro !== localWorktreeGitOptions.wslDistro
    ) {
      // The route changed during admission; the bounded overtaken rescan admits the new one.
      return {
        gitWorktrees: [],
        fresh: false,
        superseded: true,
        generation: getLocalWorktreeScanGeneration(repo.id)
      }
    }
  }
  const { observation, superseded } = await readWorktreeCatalog(
    repo,
    runtimeKey,
    {
      kind: 'desktop',
      maxAgeMs: DETECTED_WORKTREE_SCAN_CACHE_TTL_MS,
      needsHygieneClaim: needsWorktreeCatalogHygieneClaim(repo)
    },
    {
      scan: async () => {
        const worktrees = await listRepoWorktreesForDetectedScan(repo, localWorktreeGitOptions)
        return worktrees.length > 0 ? { kind: 'rows', worktrees } : { kind: 'true-empty' }
      },
      ...worktreeCatalogHygienePlan(store, repo, localWorktreeGitOptions, true)
    }
  )
  if (!observation) {
    return {
      gitWorktrees: [],
      fresh: false,
      superseded: true,
      generation: getLocalWorktreeScanGeneration(repo.id)
    }
  }
  if (observation.outcome.kind === 'failed') {
    // A failed scan must reject: an authoritative empty list would prune live worktrees.
    throw observation.outcome.error
  }
  const gitWorktrees = observation.outcome.kind === 'rows' ? observation.outcome.worktrees : []
  const generationCurrent = isLocalWorktreeScanGenerationCurrent(repo.id, observation.generation)
  // Side effects belong to the first reader of a still-current observation, whoever started its scan.
  const claim = !superseded && generationCurrent ? claimWorktreeCatalogHygiene(observation) : null
  return {
    gitWorktrees,
    fresh: claim !== null,
    superseded: superseded || !generationCurrent,
    generation: observation.generation,
    ...(claim
      ? {
          sideEffectToken: {
            generation: claim.generation,
            authorizedRootsRevision: claim.authorizedRootsRevision,
            ...localWorktreeGitOptions
          },
          hygieneDue: claim.hygieneDue,
          ...(claim.expectation ? { metadataPrune: { expectation: claim.expectation } } : {})
        }
      : {})
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
  // Owner observations registered their roots when published; folder and non-local listings register here.
  if (!sideEffectToken) {
    rememberLocalWorktreeRoots(store, repo, gitWorktrees)
  }
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
