import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  isQuietPR,
  QUIET_PR_REFRESH_INTERVAL_MS
} from '../../../../shared/github/pull-requests/refresh/pr-quiet-refresh'

// A phone's re-read right after the desktop's own lookup reuses it instead of asking GitHub again.
const PHONE_REUSE_MAX_AGE_MS = 30_000
const MAX_ENTRIES = 256

type PRLookupStart = { startedAt: number; sequence: number }

type PRLastOutcome = {
  start: PRLookupStart
  linkedPRNumber: number | null
  fallbackPRNumber: number | null
  requestKey?: string
  currentHeadOid?: string | null
  resetQuiet?: boolean
  quiet?: boolean
  // null: the last lookup was narrowed (CI-line watch), so nothing is reusable until a full one.
  outcome: PRRefreshOutcome | null
}

type ExactOutcome = PRLastOutcome & {
  latestSequence: number
  activeSequence: number | null
  holds: number
  invalidatedBeforeSequence: number
  ownerKey: string
}
const lastOutcomes = new Map<string, PRLastOutcome>()
const exactOutcomes = new Map<string, ExactOutcome>()
let lookupSequence = 0

export function startPRLookup(): PRLookupStart {
  lookupSequence += 1
  return { startedAt: Date.now(), sequence: lookupSequence }
}

function trim<T>(entries: Map<string, T>): void {
  while (entries.size > MAX_ENTRIES) {
    entries.delete(entries.keys().next().value!)
  }
}

function pinned(entry: ExactOutcome): boolean {
  return (
    entry.activeSequence !== null ||
    entry.holds > 0 ||
    (entry.outcome?.kind === 'upstream-error' &&
      Math.max(entry.outcome.nextAutoRetryAt ?? 0, entry.outcome.retryDisabledUntil ?? 0) >
        Date.now())
  )
}

export function canRetainPROutcome(requestKey: string): boolean {
  return (
    exactOutcomes.has(requestKey) ||
    exactOutcomes.size < MAX_ENTRIES ||
    [...exactOutcomes.values()].some((entry) => !pinned(entry))
  )
}

function evictExactOutcome(requestKey: string): void {
  const entry = exactOutcomes.get(requestKey)
  if (!entry) {
    return
  }
  const projection = lastOutcomes.get(entry.ownerKey)
  if (projection?.requestKey === requestKey) {
    projection.outcome = null
  }
  exactOutcomes.delete(requestKey)
}

function makeRoom(requestKey: string): boolean {
  if (exactOutcomes.has(requestKey) || exactOutcomes.size < MAX_ENTRIES) {
    return true
  }
  const victim = [...exactOutcomes].find(([, value]) => !pinned(value))
  if (!victim) {
    return false
  }
  evictExactOutcome(victim[0])
  return true
}

export function beginExactPRLookup(
  ownerKey: string,
  requestKey: string,
  start: PRLookupStart,
  resetQuiet = false
): boolean {
  const previous = exactOutcomes.get(requestKey)
  if (previous) {
    previous.latestSequence = start.sequence
    previous.activeSequence = start.sequence
    if (resetQuiet) {
      previous.quiet = false
    }
  } else if (makeRoom(requestKey)) {
    exactOutcomes.set(requestKey, {
      ownerKey,
      start,
      latestSequence: start.sequence,
      activeSequence: start.sequence,
      holds: 0,
      invalidatedBeforeSequence: 0,
      linkedPRNumber: null,
      fallbackPRNumber: null,
      outcome: null
    })
  } else {
    return false
  }
  return true
}

export function holdExactPROutcome(requestKey: string): () => void {
  const entry = exactOutcomes.get(requestKey)
  if (!entry) {
    return () => {}
  }
  entry.holds += 1
  let held = true
  return () => {
    if (held) {
      held = false
      const current = exactOutcomes.get(requestKey)
      if (current) {
        current.holds -= 1
      }
    }
  }
}

export function releaseExactPRLookup(requestKey: string, sequence: number): void {
  const entry = exactOutcomes.get(requestKey)
  if (entry?.activeSequence === sequence) {
    entry.activeSequence = null
  }
}

function invalidateOwnerSuccesses(ownerKey: string, sequence: number): void {
  for (const entry of exactOutcomes.values()) {
    if (entry.ownerKey !== ownerKey) {
      continue
    }
    entry.invalidatedBeforeSequence = Math.max(entry.invalidatedBeforeSequence, sequence)
    if (entry.outcome?.kind !== 'upstream-error' && entry.start.sequence < sequence) {
      entry.outcome = null
      entry.quiet = false
    }
  }
}

export function recordPRLastOutcome(key: string, entry: PRLastOutcome): void {
  const previous = entry.requestKey ? exactOutcomes.get(entry.requestKey) : undefined
  if (entry.outcome) {
    if (
      !previous ||
      previous.ownerKey !== key ||
      previous.latestSequence !== entry.start.sequence ||
      (entry.outcome.kind !== 'upstream-error' &&
        entry.start.sequence < previous.invalidatedBeforeSequence)
    ) {
      return
    }
  }
  if (!entry.outcome || entry.outcome.kind === 'upstream-error') {
    invalidateOwnerSuccesses(key, entry.start.sequence)
  }
  let retained = false
  if (entry.requestKey && entry.outcome && previous) {
    const quiet =
      !entry.resetQuiet &&
      previous.outcome?.kind === 'found' &&
      entry.outcome.kind === 'found' &&
      isQuietPR(entry.outcome.pr, entry.currentHeadOid ?? null) &&
      JSON.stringify(previous.outcome.pr) === JSON.stringify(entry.outcome.pr)
    exactOutcomes.delete(entry.requestKey)
    exactOutcomes.set(entry.requestKey, {
      ...entry,
      ownerKey: key,
      quiet,
      activeSequence: previous.activeSequence,
      holds: previous.holds,
      invalidatedBeforeSequence: previous.invalidatedBeforeSequence,
      latestSequence: entry.start.sequence
    })
    retained = true
  }
  const existing = lastOutcomes.get(key)
  if (!existing || existing.start.sequence <= entry.start.sequence) {
    lastOutcomes.delete(key)
    lastOutcomes.set(key, retained ? entry : { ...entry, outcome: null })
    trim(lastOutcomes)
  }
}

export function readTimedPROutcome(
  key: string,
  requestKey: string
): {
  outcome: PRRefreshOutcome
  quietIntervalMs: number | null
  /** The start of the provider read that produced it. */
  sequence: number
} | null {
  const entry = exactOutcomes.get(requestKey)
  if (!entry?.outcome || entry.ownerKey !== key) {
    return null
  }
  if (
    entry.outcome.kind !== 'upstream-error' &&
    entry.start.sequence < entry.invalidatedBeforeSequence
  ) {
    return null
  }
  return {
    outcome: entry.outcome,
    quietIntervalMs: entry.quiet ? QUIET_PR_REFRESH_INTERVAL_MS : null,
    sequence: entry.start.sequence
  }
}

export function scheduleExactPRError(
  requestKey: string,
  expected: PRRefreshOutcome,
  scheduled: PRRefreshOutcome
): void {
  const entry = exactOutcomes.get(requestKey)
  if (
    entry?.outcome === expected &&
    entry.start.sequence === entry.latestSequence &&
    scheduled.kind === 'upstream-error'
  ) {
    entry.outcome = scheduled
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
