import type { GitWorktreeInfo } from '../../../shared/worktree/types'

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
  /** Scan start, or the latest verifier answer that let a runtime reader reuse these rows. */
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
  /** Destructive hygiene is due: rows without a pre-scan hygiene claim are not good enough for this reader. */
  needsHygieneClaim?: () => boolean
}

export type WorktreeCatalogRead = {
  /** Null only for a request whose route was replaced before any observation existed. */
  observation: WorktreeCatalogObservation | null
  /** Invalidations kept overtaking scans; callers must not treat these rows as authoritative. */
  superseded: boolean
}
