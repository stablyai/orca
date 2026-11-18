import type { WorktreeCatalogObservation } from '../../../workspaces/catalog/repo-worktree-catalog-observation'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { dropRepeatedWorktreeRows } from './repeated-worktree-rows'
import { isCurrentWorktreeCatalogObservation } from '../../../workspaces/catalog/repo-worktree-catalog-owner'

const resultByObservation = new WeakMap<WorktreeCatalogObservation, RuntimeWorktreeScanResult>()
const observationByResult = new WeakMap<RuntimeWorktreeScanResult, WorktreeCatalogObservation>()
const listingByResult = new WeakMap<RuntimeWorktreeScanResult, RuntimeWorktreeScanResult>()
const lineagePrunedObservations = new WeakSet<WorktreeCatalogObservation>()

/** One stable runtime result per owner observation, so listing projections and git-run identity follow it. */
export function runtimeResultForObservation(
  observation: WorktreeCatalogObservation
): RuntimeWorktreeScanResult {
  const known = resultByObservation.get(observation)
  if (known) {
    return known
  }
  // Runtime never reports a confirmed-empty scan as success; strict failures and true-empty both read `ok:false`.
  const result =
    observation.outcome.kind === 'rows'
      ? dropRepeatedWorktreeRows({ ok: true, worktrees: observation.outcome.worktrees })
      : { ok: false, worktrees: [] }
  resultByObservation.set(observation, result)
  observationByResult.set(result, observation)
  return result
}

export function rememberRuntimeWorktreeListing(
  result: RuntimeWorktreeScanResult,
  listing: RuntimeWorktreeScanResult
): void {
  const observation = observationByResult.get(result)
  if (observation) {
    listingByResult.set(result, listing)
    observationByResult.set(listing, observation)
  }
}

export function runtimeWorktreeListingFor(
  result: RuntimeWorktreeScanResult
): RuntimeWorktreeScanResult | undefined {
  return listingByResult.get(result)
}

export function observationForRuntimeResult(
  result: RuntimeWorktreeScanResult
): WorktreeCatalogObservation | undefined {
  return observationByResult.get(result)
}

/** Lineage pruning runs once per new observation, with the generation its scan started under. */
export function claimRuntimeLineagePrune(
  result: RuntimeWorktreeScanResult
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
