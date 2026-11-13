import type {
  WorktreeCatalogObservation,
  WorktreeCatalogRequirement
} from './repo-worktree-catalog-observation'
import { isLocalWorktreeScanGenerationCurrent } from './local-worktree-scan-generation'
import { isLiveWorktreeCatalogRoute } from './repo-worktree-catalog-route'

export type Flight = {
  revision: number
  releaseObservation: () => void
  promise: Promise<WorktreeCatalogObservation>
}

export type Entry = {
  repoId: string
  hostId: string
  repoPath: string
  runtimeKey: string
  revision: number
  retired: boolean
  success: WorktreeCatalogObservation | null
  failure: WorktreeCatalogObservation | null
  flight: Flight | null
}

/** Owner identity: repo, host and the project runtime that runs Git (distro, selected Git, repair state). */
export function entryKey(repoId: string, hostId: string, runtimeKey: string): string {
  return `${repoId}\0${hostId}\0${runtimeKey}`
}

export function isLive(entry: Entry): boolean {
  return (
    !entry.retired &&
    isLiveWorktreeCatalogRoute(entry.repoId, entry.hostId, {
      repoPath: entry.repoPath,
      runtimeKey: entry.runtimeKey
    })
  )
}

export function isCurrent(entry: Entry, observation: WorktreeCatalogObservation): boolean {
  return (
    observation.revision === entry.revision &&
    isLocalWorktreeScanGenerationCurrent(entry.repoId, observation.generation) &&
    isLive(entry) &&
    (observation.authorityCurrent?.() ?? true)
  )
}

export function acceptable(
  observation: WorktreeCatalogObservation,
  requirement: WorktreeCatalogRequirement,
  now: number
): boolean {
  if (requirement.needsHygieneClaim?.() && !observation.witness?.hygieneDue) {
    return false
  }
  // Verifier confirmations are a runtime admission; other readers need a full observation that young.
  const basis = requirement.verifier ? observation.confirmedAt : observation.startedAt
  return now - basis <= requirement.maxAgeMs
}

export function releaseWitness(observation: WorktreeCatalogObservation | null): void {
  const witness = observation?.witness
  if (witness) {
    observation.witness = undefined
    witness.release()
  }
}
