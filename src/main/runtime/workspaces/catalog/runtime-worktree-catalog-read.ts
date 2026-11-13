import type { WorktreeCatalogObservation } from '../../../workspaces/catalog/repo-worktree-catalog-observation'
import type { RuntimeWorktreeScanAttempt } from './repo-worktree-resolution-scan'
import { dropRepeatedWorktreeRows } from './repeated-worktree-rows'
import { isCurrentWorktreeCatalogObservation } from '../../../workspaces/catalog/repo-worktree-catalog-owner'

const resultByObservation = new WeakMap<WorktreeCatalogObservation, RuntimeWorktreeScanAttempt>()
const observationByResult = new WeakMap<RuntimeWorktreeScanAttempt, WorktreeCatalogObservation>()
const listingByResult = new WeakMap<RuntimeWorktreeScanAttempt, RuntimeWorktreeScanAttempt>()
const lineagePrunedObservations = new WeakSet<WorktreeCatalogObservation>()

/** One stable runtime result per owner observation, so listing projections and git-run identity follow it. */
export function runtimeResultForObservation(
  observation: WorktreeCatalogObservation
): RuntimeWorktreeScanAttempt {
  const known = resultByObservation.get(observation)
  if (known) {
    return known
  }
  // Runtime never reports a confirmed-empty scan as success; strict failures and true-empty both read `ok:false`.
  const result: RuntimeWorktreeScanAttempt =
    observation.outcome.kind === 'rows'
      ? dropRepeatedWorktreeRows({ ok: true, worktrees: observation.outcome.worktrees })
      : { ok: false, worktrees: [] }
  const witnessed: RuntimeWorktreeScanAttempt = {
    ...result,
    isCurrent: () => isCurrentWorktreeCatalogObservation(observation)
  }
  resultByObservation.set(observation, witnessed)
  observationByResult.set(witnessed, observation)
  return witnessed
}

export function rememberRuntimeWorktreeListing(
  result: RuntimeWorktreeScanAttempt,
  listing: RuntimeWorktreeScanAttempt
): void {
  const observation = observationByResult.get(result)
  if (observation) {
    listingByResult.set(result, listing)
    observationByResult.set(listing, observation)
  }
}

export function runtimeWorktreeListingFor(
  result: RuntimeWorktreeScanAttempt
): RuntimeWorktreeScanAttempt | undefined {
  return listingByResult.get(result)
}

export function observationForRuntimeResult(
  result: RuntimeWorktreeScanAttempt
): WorktreeCatalogObservation | undefined {
  return observationByResult.get(result)
}

/** Lineage pruning runs once per new observation, with the generation its scan started under. */
export function claimRuntimeLineagePrune(
  result: RuntimeWorktreeScanAttempt
): { scanGeneration: number } | null {
  const observation = observationByResult.get(result)
  if (
    !observation ||
    lineagePrunedObservations.has(observation) ||
    !isCurrentWorktreeCatalogObservation(observation)
  ) {
    return null
  }
  lineagePrunedObservations.add(observation)
  return { scanGeneration: observation.generation }
}
