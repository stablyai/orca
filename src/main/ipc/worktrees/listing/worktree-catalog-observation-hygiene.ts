import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence/loading-store/store'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../../../persistence/tracking-repos/missing-local-worktree-metadata-pruning'
import type {
  WorktreeCatalogFlightPlan,
  WorktreeCatalogObservation,
  WorktreeCatalogWitness
} from '../../../workspaces/catalog/repo-worktree-catalog-owner'
import {
  isLocalWorktreeMetadataPruneDue,
  markLocalWorktreeMetadataPruneStarted,
  recordLocalWorktreeListingForPruneGate,
  requireLocalWorktreeMetadataPrune
} from '../../../workspaces/catalog/local-worktree-metadata-prune-gate'
import {
  getRegisteredWorktreeRootsRevision,
  registerWorktreeRootsForRepo
} from '../removal/registered-worktree-roots-cache'

type HygieneStore = Pick<Store, 'captureNativeLocalWorktreeMetadataScanExpectation'>

export type WorktreeCatalogHygieneWitness = WorktreeCatalogWitness & {
  readonly expectation?: NativeLocalWorktreeMetadataScanExpectation
  /** Roots revision after this observation registered its roots; later side effects fence on it. */
  rootsRevision: number
}

export type WorktreeCatalogHygieneClaim = Readonly<{
  generation: number
  authorizedRootsRevision: number
  hygieneDue: boolean
  expectation?: NativeLocalWorktreeMetadataScanExpectation
}>

/** Every reader's flight carries the same pre-scan capture, so whoever starts it observes for all (#17775). */
export function worktreeCatalogHygienePlan(
  store: Store | HygieneStore,
  repo: Repo,
  gitOptions: { wslDistro?: string }
): Pick<WorktreeCatalogFlightPlan, 'captureWitness' | 'observed'> {
  return {
    captureWitness: () => {
      const authorizedRootsRevision = getRegisteredWorktreeRootsRevision(repo.id)
      // Whole-table capture and missing-path stats run only when changed evidence makes hygiene due.
      const hygieneDue = isLocalWorktreeMetadataPruneDue(repo.id)
      if (hygieneDue) {
        markLocalWorktreeMetadataPruneStarted(repo.id)
      }
      // WSL/UNC aliases cannot establish native destructive expectations.
      const expectation =
        hygieneDue && !gitOptions.wslDistro
          ? store.captureNativeLocalWorktreeMetadataScanExpectation?.(repo)
          : undefined
      const witness: WorktreeCatalogHygieneWitness = {
        authorizedRootsRevision,
        hygieneDue,
        ...(expectation ? { expectation } : {}),
        rootsRevision: authorizedRootsRevision,
        release: () => {
          if (hygieneDue) {
            requireLocalWorktreeMetadataPrune(repo.id)
          }
        }
      }
      return witness
    },
    observed: (observation) => {
      const worktrees = observation.outcome.kind === 'rows' ? observation.outcome.worktrees : []
      // Changed listings invalidate hygiene conclusions even when native events were lost.
      recordLocalWorktreeListingForPruneGate(
        repo.id,
        worktrees.map((worktree) => worktree.path)
      )
      const witness = observation.witness as WorktreeCatalogHygieneWitness | undefined
      if (
        !witness ||
        getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
        getRegisteredWorktreeRootsRevision(repo.id) !== witness.authorizedRootsRevision
      ) {
        return
      }
      // Reuse listing roots for authorization to avoid another Git scan and macOS folder-permission prompts.
      registerWorktreeRootsForRepo(
        store as Store,
        repo,
        [repo.path, ...worktrees.map((worktree) => worktree.path)],
        gitOptions
      )
      witness.rootsRevision = getRegisteredWorktreeRootsRevision(repo.id)
    }
  }
}

/** The once-only destructive claim on a still-current observation; older rows never get new expectations. */
export function claimWorktreeCatalogHygiene(
  observation: WorktreeCatalogObservation
): WorktreeCatalogHygieneClaim | null {
  const witness = observation.witness as WorktreeCatalogHygieneWitness | undefined
  if (!witness) {
    return null
  }
  observation.witness = undefined
  return {
    generation: observation.generation,
    authorizedRootsRevision: witness.rootsRevision,
    hygieneDue: witness.hygieneDue,
    ...(witness.expectation ? { expectation: witness.expectation } : {})
  }
}
