import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import { onWorktreeScanGenerationBump } from '../../git/worktrees/catalog/worktree-scan-cache'
import { preserveFolderUpgradeWorktreePath } from './folder-upgrade-worktree-path'
import type {
  WorktreeCatalogOutcome,
  WorktreeCatalogObservation,
  WorktreeCatalogFlightPlan,
  WorktreeCatalogRequirement,
  WorktreeCatalogRead
} from './repo-worktree-catalog-observation'
import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent,
  onWorktreeRouteInputsChanged
} from './local-worktree-scan-generation'
import {
  isLiveWorktreeCatalogRoute,
  setWorktreeCatalogRouteResolver
} from './repo-worktree-catalog-route'
import { verify } from './repo-worktree-catalog-verification'
import {
  acceptable,
  entryKey,
  isCurrent,
  isLive,
  releaseWitness,
  type Entry,
  type Flight
} from './repo-worktree-catalog-entry'
import { onWslDiscoveryChanged } from '../../wsl/discovery/wsl-discovery-change'

const entries = new Map<string, Entry>()
const neverCurrent = (): boolean => false

onWorktreeScanGenerationBump((repoPath) => invalidateWorktreeCatalogForRepoPath(repoPath))
// Route-changing writes and WSL discovery answers retire obsolete owners even when no reader follows.
onWorktreeRouteInputsChanged(() => retireObsoleteWorktreeCatalogs())
onWslDiscoveryChanged(() => retireObsoleteWorktreeCatalogs())
const entryByObservation = new WeakMap<WorktreeCatalogObservation, Entry>()

function retireEntry(key: string, entry: Entry): void {
  entries.delete(key)
  entry.retired = true
  entry.revision += 1
  entry.flight?.releaseObservation()
  releaseWitness(entry.success)
}

/** The owner for a live route; only a live route may create it or retire the repo's other routes. */
function resolveEntry(repo: Repo, runtimeKey: string): Entry {
  const hostId = getRepoExecutionHostId(repo)
  const key = entryKey(repo.id, hostId, runtimeKey)
  const scope = entryKey(repo.id, hostId, '')
  for (const [candidateKey, candidate] of entries) {
    // One project runtime runs a repo's Git at a time; rows from another route are obsolete.
    if (
      candidateKey.startsWith(scope) &&
      (candidateKey !== key || !areWorktreePathsEqual(candidate.repoPath, repo.path))
    ) {
      retireEntry(candidateKey, candidate)
    }
  }
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      repoId: repo.id,
      hostId,
      repoPath: repo.path,
      runtimeKey,
      revision: 0,
      retired: false,
      success: null,
      failure: null,
      flight: null
    }
    entries.set(key, entry)
  }
  return entry
}

function startFlight(
  entry: Entry,
  repo: Repo,
  requirement: WorktreeCatalogRequirement,
  plan: WorktreeCatalogFlightPlan,
  pendingProbe: Promise<string | null> | null
): Flight {
  // Capture before Git can yield so a concurrent mutation is never stamped as observed.
  const revision = entry.revision
  const generation = getLocalWorktreeScanGeneration(entry.repoId)
  const startedAt = Date.now()
  const probe = pendingProbe ?? requirement.verifier?.probe() ?? null
  const adminFingerprint = probe && probe !== 'in-flight' ? probe : null
  const witness = plan.captureWitness?.()
  let observationCommit:
    | ReturnType<NonNullable<WorktreeCatalogFlightPlan['captureObservation']>>
    | undefined
  let scan: Promise<WorktreeCatalogOutcome>
  try {
    observationCommit = plan.captureObservation?.()
    scan = plan.scan()
  } catch (error) {
    scan = Promise.resolve({ kind: 'failed', error })
  }
  const authorityCurrent = observationCommit?.isCurrent
  const releaseObservation = (): void => {
    observationCommit?.release()
    observationCommit = undefined
  }
  const flight: Flight = {
    revision,
    releaseObservation,
    promise: scan
      .catch((error: unknown): WorktreeCatalogOutcome => ({ kind: 'failed', error }))
      .then((outcome) => {
        let acceptedAuthority = authorityCurrent
        let settled = outcome
        try {
          if (outcome.kind === 'rows') {
            const seen = new Set<string>()
            const worktrees = preserveFolderUpgradeWorktreePath(repo, outcome.worktrees).filter(
              (row) => {
                if (seen.has(row.path)) {
                  return false
                }
                seen.add(row.path)
                return true
              }
            )
            settled = { kind: 'rows', worktrees }
            const current =
              revision === entry.revision &&
              isLocalWorktreeScanGenerationCurrent(entry.repoId, generation) &&
              isLive(entry) &&
              (entry.success?.startedAt ?? -1) <= startedAt &&
              (authorityCurrent?.() ?? true)
            if (current && authorityCurrent && !observationCommit?.commit(worktrees)) {
              acceptedAuthority = neverCurrent
            }
          }
        } catch (error) {
          settled = { kind: 'failed', error }
        } finally {
          releaseObservation()
        }
        const observation: WorktreeCatalogObservation = {
          outcome: settled,
          startedAt,
          generation,
          revision,
          adminFingerprint,
          startedBy: requirement.kind,
          witness,
          ...(acceptedAuthority ? { authorityCurrent: acceptedAuthority } : {}),
          confirmedAt: startedAt
        }
        entryByObservation.set(observation, entry)
        if (entry.flight === flight) {
          entry.flight = null
        }
        publish(entry, observation, plan)
        return observation
      })
  }
  entry.flight = flight
  if (
    revision !== entry.revision ||
    !isLocalWorktreeScanGenerationCurrent(entry.repoId, generation) ||
    !isLive(entry) ||
    authorityCurrent?.() === false
  ) {
    releaseObservation()
  }
  return flight
}

function publish(
  entry: Entry,
  observation: WorktreeCatalogObservation,
  plan: WorktreeCatalogFlightPlan
): void {
  const live = isLive(entry)
  if (observation.outcome.kind === 'failed') {
    // Like the evidence gate's own claim, a failed pass is not retried on every read (#17775); new evidence re-arms it.
    observation.witness = undefined
    if (live && (entry.failure?.startedAt ?? -1) <= observation.startedAt) {
      entry.failure = observation
    }
    return
  }
  // An obsolete route or a newer published observation keeps late completions out.
  if (!live || (entry.success?.startedAt ?? -1) > observation.startedAt) {
    releaseWitness(observation)
    return
  }
  releaseWitness(entry.success)
  entry.success = observation
  if (entry.failure && entry.failure.startedAt <= observation.startedAt) {
    entry.failure = null
  }
  if (isCurrent(entry, observation)) {
    plan.observed?.(observation)
  }
}

/** The sole owner of a repo's raw worktree rows: readers state what they accept and share its one flight. */
export async function readWorktreeCatalog(
  repo: Repo,
  runtimeKey: string,
  requirement: WorktreeCatalogRequirement,
  plan: WorktreeCatalogFlightPlan
): Promise<WorktreeCatalogRead> {
  const hostId = getRepoExecutionHostId(repo)
  // A request admitted for a route the registration has since replaced runs no Git and retires nothing.
  if (!isLiveWorktreeCatalogRoute(repo.id, hostId, { repoPath: repo.path, runtimeKey })) {
    const known = entries.get(entryKey(repo.id, hostId, runtimeKey))?.success ?? null
    return { observation: known, superseded: true }
  }
  const entry = resolveEntry(repo, runtimeKey)
  let last: WorktreeCatalogObservation | null = null
  for (let flights = 0; flights < (requirement.overtakenFlights ?? 1); flights += 1) {
    const now = Date.now()
    const failure = entry.failure
    if (
      requirement.reusesFailure &&
      failure?.startedBy === requirement.kind &&
      isCurrent(entry, failure) &&
      now - failure.startedAt <= requirement.maxAgeMs
    ) {
      return { observation: failure, superseded: false }
    }
    const success = entry.success
    let pendingProbe: Promise<string | null> | null = null
    if (success && isCurrent(entry, success)) {
      if (acceptable(success, requirement, now)) {
        return { observation: success, superseded: false }
      }
      if (requirement.verifier && !requirement.needsHygieneClaim?.()) {
        const verification = await verify(success, requirement.verifier, now)
        if (verification.reuse && entry.success === success && isCurrent(entry, success)) {
          success.confirmedAt = Math.max(success.confirmedAt, Date.now())
          return { observation: success, superseded: false }
        }
        pendingProbe = verification.reuse ? null : verification.probe
      }
    }
    // The route can be replaced across any await; obsolete readers never start Git.
    if (!isLive(entry)) {
      break
    }
    // At most one flight per owner: a reader arriving after an invalidation waits for the
    // overtaken flight, then starts the single trailing one.
    last = await (entry.flight ?? startFlight(entry, repo, requirement, plan, pendingProbe)).promise
    if (isCurrent(entry, last)) {
      return { observation: last, superseded: false }
    }
  }
  return { observation: last ?? entry.success, superseded: true }
}

/** Last known observation, current or not, for last-known fallbacks and projections. */
export function peekWorktreeCatalog(
  repo: Repo,
  runtimeKey: string
): { observation: WorktreeCatalogObservation; current: boolean } | null {
  const entry = entries.get(entryKey(repo.id, getRepoExecutionHostId(repo), runtimeKey))
  const observation = entry?.success
  if (!entry || !observation || !areWorktreePathsEqual(entry.repoPath, repo.path)) {
    return null
  }
  return { observation, current: isCurrent(entry, observation) }
}

/** Destructive consumers recheck this after their own awaits, with the owner's own authority rules. */
export function isCurrentWorktreeCatalogObservation(
  observation: WorktreeCatalogObservation
): boolean {
  const entry = entryByObservation.get(observation)
  // A newer published success supersedes this one even when nothing invalidated the owner.
  return entry !== undefined && entry.success === observation && isCurrent(entry, observation)
}

/** Stops readers from reusing settled rows; joiners of an older flight follow the next one. */
export function invalidateWorktreeCatalogForRepo(repoId: string): void {
  for (const entry of entries.values()) {
    if (entry.repoId === repoId) {
      entry.revision += 1
      entry.flight?.releaseObservation()
    }
  }
}

/** Git-layer mutations know only the path; every namespace listing it is stale. */
export function invalidateWorktreeCatalogForRepoPath(repoPath: string): void {
  for (const entry of entries.values()) {
    if (areWorktreePathsEqual(entry.repoPath, repoPath)) {
      entry.revision += 1
      entry.flight?.releaseObservation()
    }
  }
}

/** Drop owners whose repo, host, path or project runtime is no longer the live route. */
export function retireObsoleteWorktreeCatalogs(): void {
  for (const [key, entry] of entries) {
    if (!isLive(entry)) {
      retireEntry(key, entry)
    }
  }
}

export function _resetWorktreeCatalogOwnerForTests(): void {
  // Shared test workers outlive the runtime whose store registered the resolver.
  setWorktreeCatalogRouteResolver(null)
  for (const [key, entry] of entries) {
    retireEntry(key, entry)
  }
}

export function _getWorktreeCatalogOwnerSizeForTests(): number {
  return entries.size
}
