import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence/loading-store/store'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../../../persistence/tracking-repos/missing-local-worktree-metadata-pruning'
import type {
  WorktreeCatalogFlightPlan,
  WorktreeCatalogObservation,
  WorktreeCatalogWitness
} from '../../../workspaces/catalog/repo-worktree-catalog-observation'
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

export type WorktreeCatalogHygieneClaim = Readonly<{
  generation: number
  authorizedRootsRevision: number
  hygieneDue: boolean
  expectation?: NativeLocalWorktreeMetadataScanExpectation
}>

/** Pre-scan facts for every flight; only readers that prune claim the evidence gate (#17775). */
export function worktreeCatalogHygienePlan(
  store: Store,
  repo: Repo,
  gitOptions: { wslDistro?: string },
  claimsHygiene: boolean
): Pick<WorktreeCatalogFlightPlan, 'captureWitness' | 'observed'> {
  return {
    captureWitness: () => {
      const authorizedRootsRevision = getRegisteredWorktreeRootsRevision(repo.id)
      // Whole-table capture and missing-path stats run only when changed evidence makes hygiene due,
      // and only for a reader that will consume them; unclaimed captures would re-arm and repeat.
      const hygieneDue = claimsHygiene && isLocalWorktreeMetadataPruneDue(repo.id)
      if (hygieneDue) {
        markLocalWorktreeMetadataPruneStarted(repo.id)
      }
      // WSL/UNC aliases cannot establish native destructive expectations.
      const expectation =
        hygieneDue && !gitOptions.wslDistro
          ? store.captureNativeLocalWorktreeMetadataScanExpectation?.(repo)
          : undefined
      const witness: WorktreeCatalogWitness = {
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
      const witness = observation.witness
      if (
        !witness ||
        getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
        getRegisteredWorktreeRootsRevision(repo.id) !== witness.authorizedRootsRevision
      ) {
        return
      }
      // Reuse listing roots for authorization to avoid another Git scan and macOS folder-permission prompts.
      registerWorktreeRootsForRepo(
        store,
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
  const witness = observation.witness
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

/** A pruning reader must not settle for rows observed without its pre-scan claim while hygiene is due. */
export function needsWorktreeCatalogHygieneClaim(repo: Repo): () => boolean {
  return () => isLocalWorktreeMetadataPruneDue(repo.id)
}
