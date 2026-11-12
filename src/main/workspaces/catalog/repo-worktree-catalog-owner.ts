import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import { onWorktreeScanGenerationBump } from '../../git/worktrees/catalog/worktree-scan-cache'
import { preserveFolderUpgradeWorktreePath } from './folder-upgrade-worktree-path'
import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from './local-worktree-scan-generation'

/** One `git worktree list`; a confirmed missing/non-repo stays distinct from a failed run. */
export type WorktreeCatalogOutcome =
  | { kind: 'rows'; worktrees: GitWorktreeInfo[] }
  | { kind: 'true-empty' }
  | { kind: 'failed'; error: unknown }

/** Captured before Git runs; destructive consumers claim it at most once. */
export type WorktreeCatalogWitness = {
  readonly authorizedRootsRevision: number
  readonly hygieneDue: boolean
  readonly expectation?: unknown
  /** Returns an unconsumed claim so the evidence gate can re-arm. */
  readonly release: () => void
}

export type WorktreeCatalogObservation = {
  readonly outcome: WorktreeCatalogOutcome
  /** Scan start: verification never moves it, so the full-list ceiling cannot slide. */
  readonly startedAt: number
  readonly generation: number
  readonly revision: number
  /** Only runtime-started flights fingerprint first; without one the rows cannot be verified. */
  readonly adminFingerprint: Promise<string | null> | null
  readonly startedBy: WorktreeCatalogReaderKind
  witness: WorktreeCatalogWitness | undefined
  /** Scan start, or the latest verifier answer that let a reader reuse these rows. */
  confirmedAt: number
}

export type WorktreeCatalogFlightPlan = {
  scan: () => Promise<WorktreeCatalogOutcome>
  captureWitness?: () => WorktreeCatalogWitness | undefined
  observed?: (observation: WorktreeCatalogObservation) => void
}

export type WorktreeCatalogVerifier = {
  /** Full-list ceiling measured from scan start. */
  ceilingMs: number
  /** One outstanding probe per repo; 'in-flight' and timeouts reuse rows without proving them (#19312). */
  probe: () => Promise<string | null> | 'in-flight'
  timeoutMs: number
  onUnknown?: (reason: string) => void
}

export type WorktreeCatalogReaderKind = 'desktop' | 'runtime'

export type WorktreeCatalogRequirement = {
  kind: WorktreeCatalogReaderKind
  /** Oldest confirmation this reader accepts; a fresher demand refreshes the shared observation. */
  maxAgeMs: number
  /** Reuse failures only from this reader kind's own attempts; another kind's failure never blacks out a retry. */
  reusesFailure?: boolean
  verifier?: WorktreeCatalogVerifier
  /** Trailing flights this read follows when mutations overtake it; callers with their own rescan loop keep 1. */
  overtakenFlights?: number
}

export type WorktreeCatalogRead = {
  observation: WorktreeCatalogObservation
  /** Invalidations kept overtaking scans; callers must not treat these rows as authoritative. */
  superseded: boolean
}

type Flight = {
  revision: number
  promise: Promise<WorktreeCatalogObservation>
}

type Entry = {
  repoId: string
  repoPath: string
  revision: number
  success: WorktreeCatalogObservation | null
  failure: WorktreeCatalogObservation | null
  flight: Flight | null
}

const entries = new Map<string, Entry>()

onWorktreeScanGenerationBump((repoPath) => invalidateWorktreeCatalogForRepoPath(repoPath))

/** Owner identity: repo, host and the project runtime that runs Git (distro, selected Git, repair state). */
function entryKey(repo: Repo, runtimeKey: string): string {
  return `${repo.id}\0${getRepoExecutionHostId(repo)}\0${runtimeKey}`
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
  entry.revision += 1
  releaseWitness(entry.success)
}

function isCurrent(entry: Entry, observation: WorktreeCatalogObservation): boolean {
  return (
    observation.revision === entry.revision &&
    isLocalWorktreeScanGenerationCurrent(entry.repoId, observation.generation)
  )
}

function startFlight(
  key: string,
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
        publish(key, entry, observation, plan)
        return observation
      })
  }
  entry.flight = flight
  return flight
}

function publish(
  key: string,
  entry: Entry,
  observation: WorktreeCatalogObservation,
  plan: WorktreeCatalogFlightPlan
): void {
  const retired = entries.get(key) !== entry
  if (observation.outcome.kind === 'failed') {
    releaseWitness(observation)
    if (!retired && (entry.failure?.startedAt ?? -1) <= observation.startedAt) {
      entry.failure = observation
    }
    return
  }
  // A retired owner or a newer published observation keeps late completions out.
  if (retired || (entry.success?.startedAt ?? -1) > observation.startedAt) {
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

type Verification = { reuse: true } | { reuse: false; probe: Promise<string | null> | null }

async function verify(
  observation: WorktreeCatalogObservation,
  verifier: WorktreeCatalogVerifier,
  now: number
): Promise<Verification> {
  if (observation.outcome.kind !== 'rows' || now - observation.startedAt >= verifier.ceilingMs) {
    return { reuse: false, probe: null }
  }
  // Probe before any rescan so changes during it cannot be stamped as already observed.
  const probe = verifier.probe()
  if (probe === 'in-flight') {
    verifier.onUnknown?.('previous probe still pending')
    return { reuse: true }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), verifier.timeoutMs)
  })
  const current = await Promise.race([probe, timeout]).finally(() => clearTimeout(timer))
  if (current === 'timeout') {
    // Unknown is not proof, but rescanning slow mounts on every read amplifies load (#19312).
    verifier.onUnknown?.('probe expired')
    return { reuse: true }
  }
  const recorded = observation.adminFingerprint ? await observation.adminFingerprint : null
  // Only a known fingerprint taken before this observation's scan proves nothing changed.
  return current !== null && recorded === current ? { reuse: true } : { reuse: false, probe }
}

function acceptsAge(
  observation: WorktreeCatalogObservation,
  requirement: WorktreeCatalogRequirement,
  now: number
): boolean {
  return now - observation.confirmedAt <= requirement.maxAgeMs
}

/** The sole owner of a repo's raw worktree rows: readers state what they accept and share its flights. */
export async function readWorktreeCatalog(
  repo: Repo,
  runtimeKey: string,
  requirement: WorktreeCatalogRequirement,
  plan: WorktreeCatalogFlightPlan
): Promise<WorktreeCatalogRead> {
  const key = entryKey(repo, runtimeKey)
  let entry = entries.get(key)
  if (entry && !areWorktreePathsEqual(entry.repoPath, repo.path)) {
    retireEntry(key, entry)
    entry = undefined
  }
  if (!entry) {
    entry = {
      repoId: repo.id,
      repoPath: repo.path,
      revision: 0,
      success: null,
      failure: null,
      flight: null
    }
    entries.set(key, entry)
  }
  let last: WorktreeCatalogObservation | null = null
  for (let flights = 0; flights < (requirement.overtakenFlights ?? 1); flights += 1) {
    const now = Date.now()
    const failure = entry.failure
    if (
      requirement.reusesFailure &&
      failure?.startedBy === requirement.kind &&
      isCurrent(entry, failure) &&
      acceptsAge(failure, requirement, now)
    ) {
      return { observation: failure, superseded: false }
    }
    const success = entry.success
    let pendingProbe: Promise<string | null> | null = null
    if (success && isCurrent(entry, success)) {
      if (acceptsAge(success, requirement, now)) {
        return { observation: success, superseded: false }
      }
      if (requirement.verifier) {
        const verification = await verify(success, requirement.verifier, now)
        if (verification.reuse && entry.success === success && isCurrent(entry, success)) {
          success.confirmedAt = Math.max(success.confirmedAt, Date.now())
          return { observation: success, superseded: false }
        }
        pendingProbe = verification.reuse ? null : verification.probe
      }
    }
    const joinable = entry.flight?.revision === entry.revision ? entry.flight : null
    last = await (joinable ?? startFlight(key, entry, repo, requirement, plan, pendingProbe))
      .promise
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

/** Drop owners whose repo or host registration is gone; late completions cannot recreate them. */
export function retireUnregisteredWorktreeCatalogs(registered: readonly Repo[]): void {
  const live = new Set(registered.map((repo) => `${repo.id}\0${getRepoExecutionHostId(repo)}\0`))
  for (const [key, entry] of entries) {
    const prefix = key.slice(0, key.lastIndexOf('\0') + 1)
    if (!live.has(prefix)) {
      retireEntry(key, entry)
    }
  }
}

export function _resetWorktreeCatalogOwnerForTests(): void {
  for (const [key, entry] of entries) {
    retireEntry(key, entry)
  }
}

export function _getWorktreeCatalogOwnerSizeForTests(): number {
  return entries.size
}
