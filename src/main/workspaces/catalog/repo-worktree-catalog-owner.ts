import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import { onWorktreeScanGenerationBump } from '../../git/worktrees/catalog/worktree-scan-cache'
import { preserveFolderUpgradeWorktreePath } from './folder-upgrade-worktree-path'
import type {
  WorktreeCatalogOutcome,
  WorktreeCatalogObservation,
  WorktreeCatalogFlightPlan,
  WorktreeCatalogVerifier,
  WorktreeCatalogRequirement,
  WorktreeCatalogRead
} from './repo-worktree-catalog-observation'
import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from './local-worktree-scan-generation'

type Flight = {
  revision: number
  promise: Promise<WorktreeCatalogObservation>
}

type Entry = {
  repoId: string
  repoPath: string
  runtimeKey: string
  revision: number
  retired: boolean
  success: WorktreeCatalogObservation | null
  failure: WorktreeCatalogObservation | null
  flight: Flight | null
}

const entries = new Map<string, Entry>()

onWorktreeScanGenerationBump((repoPath) => invalidateWorktreeCatalogForRepoPath(repoPath))

function repoScope(repo: Repo): string {
  return `${repo.id}\0${getRepoExecutionHostId(repo)}\0`
}

/** Owner identity: repo, host and the project runtime that runs Git (distro, selected Git, repair state). */
function entryKey(repo: Repo, runtimeKey: string): string {
  return `${repoScope(repo)}${runtimeKey}`
}

function releaseWitness(observation: WorktreeCatalogObservation | null): void {
  const witness = observation?.witness
  if (witness) {
    observation.witness = undefined
    witness.release()
  }
}

function retireEntry(key: string, entry: Entry): void {
  entries.delete(key)
  entry.retired = true
  entry.revision += 1
  releaseWitness(entry.success)
}

/** The live owner for this repo and runtime; a path or runtime change retires the old one. */
function resolveEntry(repo: Repo, runtimeKey: string): { key: string; entry: Entry } {
  const key = entryKey(repo, runtimeKey)
  const scope = repoScope(repo)
  for (const [candidateKey, candidate] of entries) {
    // One project runtime runs a repo's Git at a time; rows from another one are obsolete.
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
  return { key, entry }
}

function isCurrent(entry: Entry, observation: WorktreeCatalogObservation): boolean {
  return (
    !entry.retired &&
    observation.revision === entry.revision &&
    isLocalWorktreeScanGenerationCurrent(entry.repoId, observation.generation)
  )
}

function startFlight(
  entry: Entry,
  repo: Repo,
  requirement: WorktreeCatalogRequirement,
  plan: WorktreeCatalogFlightPlan
): Flight {
  // Capture before Git can yield so a concurrent mutation is never stamped as observed.
  const revision = entry.revision
  const generation = getLocalWorktreeScanGeneration(entry.repoId)
  const startedAt = Date.now()
  const probe = requirement.verifier?.probe() ?? null
  const adminFingerprint = probe && probe !== 'in-flight' ? probe : null
  const witness = plan.captureWitness?.()
  const flight: Flight = {
    revision,
    promise: plan
      .scan()
      .catch((error: unknown): WorktreeCatalogOutcome => ({ kind: 'failed', error }))
      .then((outcome) => {
        const observation: WorktreeCatalogObservation = {
          outcome:
            outcome.kind === 'rows'
              ? // Owners are per repo id, so this registration's locator cannot leak into another.
                {
                  kind: 'rows',
                  worktrees: preserveFolderUpgradeWorktreePath(repo, outcome.worktrees)
                }
              : outcome,
          startedAt,
          generation,
          revision,
          adminFingerprint,
          startedBy: requirement.kind,
          witness,
          confirmedAt: startedAt
        }
        if (entry.flight === flight) {
          entry.flight = null
        }
        publish(entry, observation, plan)
        return observation
      })
  }
  entry.flight = flight
  return flight
}

function publish(
  entry: Entry,
  observation: WorktreeCatalogObservation,
  plan: WorktreeCatalogFlightPlan
): void {
  if (observation.outcome.kind === 'failed') {
    // Like the evidence gate's own claim, a failed pass is not retried on every read (#17775); new evidence re-arms it.
    observation.witness = undefined
    if (!entry.retired && (entry.failure?.startedAt ?? -1) <= observation.startedAt) {
      entry.failure = observation
    }
    return
  }
  // A retired owner or a newer published observation keeps late completions out.
  if (entry.retired || (entry.success?.startedAt ?? -1) > observation.startedAt) {
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

/** True when a probe proves, or cannot yet disprove (#19312), that rows with a pre-scan fingerprint still hold. */
async function verify(
  observation: WorktreeCatalogObservation,
  verifier: WorktreeCatalogVerifier,
  now: number
): Promise<boolean> {
  // Without a fingerprint from before its scan, no probe can certify these rows.
  if (
    observation.outcome.kind !== 'rows' ||
    !observation.adminFingerprint ||
    now - observation.startedAt >= verifier.ceilingMs
  ) {
    return false
  }
  const probe = verifier.probe()
  if (probe === 'in-flight') {
    verifier.onUnknown?.('previous probe still pending')
    return true
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), verifier.timeoutMs)
  })
  const current = await Promise.race([probe, timeout]).finally(() => clearTimeout(timer))
  if (current === 'timeout') {
    // Unknown is not proof, but rescanning slow mounts on every read amplifies load (#19312).
    verifier.onUnknown?.('probe expired')
    return true
  }
  return current !== null && (await observation.adminFingerprint) === current
}

function acceptable(
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

/** The sole owner of a repo's raw worktree rows: readers state what they accept and share its one flight. */
export async function readWorktreeCatalog(
  repo: Repo,
  runtimeKey: string,
  requirement: WorktreeCatalogRequirement,
  plan: WorktreeCatalogFlightPlan
): Promise<WorktreeCatalogRead> {
  let last: WorktreeCatalogObservation | null = null
  const { entry } = resolveEntry(repo, runtimeKey)
  for (let flights = 0; flights < (requirement.overtakenFlights ?? 1); flights += 1) {
    // A newer runtime or path took over this repo mid-read; this reader's rows stay non-authoritative.
    if (entry.retired && last) {
      break
    }
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
    if (success && isCurrent(entry, success)) {
      if (acceptable(success, requirement, now)) {
        return { observation: success, superseded: false }
      }
      if (
        requirement.verifier &&
        !requirement.needsHygieneClaim?.() &&
        (await verify(success, requirement.verifier, now)) &&
        entry.success === success &&
        isCurrent(entry, success)
      ) {
        success.confirmedAt = Math.max(success.confirmedAt, Date.now())
        return { observation: success, superseded: false }
      }
    }
    // At most one flight per owner: a reader arriving after an invalidation waits for the
    // overtaken flight, then starts the single trailing one.
    last = await (entry.flight ?? startFlight(entry, repo, requirement, plan)).promise
    if (isCurrent(entry, last)) {
      return { observation: last, superseded: false }
    }
  }
  return { observation: last!, superseded: true }
}

/** Last known observation, current or not, for last-known fallbacks and projections. */
export function peekWorktreeCatalog(
  repo: Repo,
  runtimeKey: string
): { observation: WorktreeCatalogObservation; current: boolean } | null {
  const entry = entries.get(entryKey(repo, runtimeKey))
  const observation = entry?.success
  if (!entry || !observation || !areWorktreePathsEqual(entry.repoPath, repo.path)) {
    return null
  }
  return { observation, current: isCurrent(entry, observation) }
}

/** Stops readers from reusing settled rows; joiners of an older flight follow the next one. */
export function invalidateWorktreeCatalogForRepo(repoId: string): void {
  for (const entry of entries.values()) {
    if (entry.repoId === repoId) {
      entry.revision += 1
    }
  }
}

/** Git-layer mutations know only the path; every namespace listing it is stale. */
export function invalidateWorktreeCatalogForRepoPath(repoPath: string): void {
  for (const entry of entries.values()) {
    if (areWorktreePathsEqual(entry.repoPath, repoPath)) {
      entry.revision += 1
    }
  }
}

/** Drop owners whose repo, host or project runtime is gone; late completions cannot recreate them. */
export function retireUnregisteredWorktreeCatalogs(
  registered: readonly Repo[],
  runtimeKeyFor: (repo: Repo) => string
): void {
  const live = new Set(registered.map((repo) => entryKey(repo, runtimeKeyFor(repo))))
  for (const [key, entry] of entries) {
    if (!live.has(key)) {
      retireEntry(key, entry)
    }
  }
}

export function _resetWorktreeCatalogOwnerForTests(): void {
  for (const [key, entry] of entries) {
    retireEntry(key, entry)
  }
}
