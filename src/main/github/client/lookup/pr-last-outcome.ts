import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import {
  reviewRefreshIntervalMs,
  type PRAutoRefreshCadence
} from '../../../../shared/review-refresh-policy'

// A phone's re-read right after the desktop's own lookup reuses it instead of asking GitHub again.
const PHONE_REUSE_MAX_AGE_MS = 30_000
const MAX_ENTRIES = 256

type PRLookupStart = { startedAt: number; sequence: number }

type PRLastOutcome = {
  start: PRLookupStart
  linkedPRNumber: number | null
  fallbackPRNumber: number | null
  /** Whether a merged fallback PR counted as an answer; it decides between found and no-pr. */
  acceptMergedFallbackPR: boolean
  /** The checkout HEAD the lookup was asked about; a new commit may have opened or moved a PR. */
  headOid: string | null
  // null: the last lookup was narrowed (CI-line watch), so nothing is reusable until a full one.
  outcome: PRRefreshOutcome | null
}

const lastOutcomes = new Map<string, PRLastOutcome>()
let lookupSequence = 0

// Two lookups can start in the same millisecond; the sequence still orders them.
export function startPRLookup(): PRLookupStart {
  lookupSequence += 1
  return { startedAt: Date.now(), sequence: lookupSequence }
}

export function recordPRLastOutcome(key: string, entry: PRLastOutcome): void {
  const existing = lastOutcomes.get(key)
  // A lookup that started earlier but settled later must not replace a newer answer.
  if (existing && existing.start.sequence > entry.start.sequence) {
    return
  }
  lastOutcomes.delete(key)
  lastOutcomes.set(key, entry)
  // Size-bounded only: a slower host cadence reuses answers far older than the phone window.
  for (const oldestKey of lastOutcomes.keys()) {
    if (lastOutcomes.size <= MAX_ENTRIES) {
      break
    }
    lastOutcomes.delete(oldestKey)
  }
}

/** With a slower host cadence, a client's timed read reuses the last full answer for the same
 *  request until this host's own interval for that answer has passed ("off": until an explicit read). */
export function readPacedPROutcome(
  key: string,
  request: {
    linkedPRNumber: number | null
    fallbackPRNumber: number | null
    acceptMergedFallbackPR: boolean
    currentHeadOid: string | null
  },
  cadence: PRAutoRefreshCadence
): PRRefreshOutcome | null {
  if (cadence === 'default') {
    return null
  }
  const entry = lastOutcomes.get(key)
  const outcome = entry?.outcome
  // Same identity as the in-flight lookup key: one caller's fallback policy never answers another's.
  if (
    !entry ||
    !outcome ||
    outcome.kind === 'upstream-error' ||
    entry.linkedPRNumber !== request.linkedPRNumber ||
    entry.fallbackPRNumber !== request.fallbackPRNumber ||
    entry.acceptMergedFallbackPR !== request.acceptMergedFallbackPR ||
    entry.headOid !== request.currentHeadOid
  ) {
    return null
  }
  const pr = outcome.kind === 'found' ? outcome.pr : null
  // Selected pacing is the shortest timed interval, so the host never outpaces a selected client.
  const interval = reviewRefreshIntervalMs(
    {
      state: pr?.state ?? null,
      checksStatus: pr?.checksStatus ?? null,
      hasReview: pr !== null,
      selected: true
    },
    cadence
  )
  if (interval !== null && Date.now() - entry.start.startedAt >= interval) {
    return null
  }
  return outcome
}

/** Only an open PR whose own head is the request's head: a push can't have moved it, and merged or
 * fallback rules still get a real lookup. */
export function readRecentOpenPROutcome(
  key: string,
  request: {
    linkedPRNumber: number | null
    fallbackPRNumber: number | null
    currentHeadOid: string | null
  }
): PRRefreshOutcome | null {
  const entry = lastOutcomes.get(key)
  const outcome = entry?.outcome
  if (
    !entry ||
    outcome?.kind !== 'found' ||
    Date.now() - entry.start.startedAt >= PHONE_REUSE_MAX_AGE_MS ||
    (outcome.pr.state !== 'open' && outcome.pr.state !== 'draft') ||
    entry.linkedPRNumber !== request.linkedPRNumber ||
    // The stored fallback number may be how it was found; another fallback could find another PR.
    (outcome.pr.number === entry.fallbackPRNumber &&
      entry.fallbackPRNumber !== request.fallbackPRNumber) ||
    !request.currentHeadOid ||
    outcome.pr.headSha !== request.currentHeadOid
  ) {
    return null
  }
  return outcome
}
