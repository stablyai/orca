import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'

// A phone's re-read right after the desktop's own lookup reuses it instead of asking GitHub again.
const PHONE_REUSE_MAX_AGE_MS = 30_000
const MAX_ENTRIES = 256

type PRLookupStart = { startedAt: number; sequence: number }

type PRLastOutcome = {
  start: PRLookupStart
  linkedPRNumber: number | null
  fallbackPRNumber: number | null
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
  const now = Date.now()
  for (const [oldestKey, oldest] of lastOutcomes) {
    if (lastOutcomes.size <= MAX_ENTRIES && now - oldest.start.startedAt < PHONE_REUSE_MAX_AGE_MS) {
      break
    }
    lastOutcomes.delete(oldestKey)
  }
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
