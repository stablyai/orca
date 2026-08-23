import {
  BROWSER_RETENTION_LIMIT,
  type BrowserRetentionBudget,
  type BrowserRetentionCandidate
} from '../../shared/browser-retention-budget'

// Why (STA-4341): on a headless `orca serve` host every agent-opened browser
// page is backed by its own hidden BrowserWindow, i.e. its own renderer
// process. Nothing owned those renderers, so a long agent session accumulated
// them until the host saturated. This module configures the shared browser
// retention budget for that host and answers when the decision could next
// change — a headless host has no visibility event to react to, so it has to
// know its own deadlines.

/** Resident renderers kept warm. The desktop guest budget uses the same 4. */
export const OFFSCREEN_BROWSER_RESIDENT_LIMIT = BROWSER_RETENTION_LIMIT
/** An untouched page parks once idle this long, even under the limit. */
export const OFFSCREEN_BROWSER_IDLE_PARK_MS = 5 * 60_000
/** A page is never parked before this much time without a command. */
export const OFFSCREEN_BROWSER_PARK_GRACE_MS = 30_000

// Why a re-check at all: a page pinned by a download, a streamed client or a
// certificate prompt releases that pin with no event this backend observes, so
// its deadline is unknowable. Re-asking on the grace cadence is bounded, runs
// only while something is genuinely in flight, and stops with the last pin —
// unlike a fixed sweep, which ran forever on a host doing nothing.
export const OFFSCREEN_BROWSER_PINNED_RECHECK_MS = OFFSCREEN_BROWSER_PARK_GRACE_MS

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }
  // Why Number, not parseInt: parseInt('1e9') is 1, silently turning the
  // documented "set the idle window very high" advice into a 1ms window.
  // Number() consumes the whole string, so '1e9' parses fully and trailing
  // garbage falls back instead of truncating.
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    // Why the warning: parseInt used to truncate '60000ms' to 60000; falling
    // back silently would change such a knob's behavior with no signal.
    console.warn(`[offscreen-browser] ignoring invalid ${name}=${raw}`)
    return fallback
  }
  return parsed
}

export function readOffscreenBrowserRetentionBudget(): BrowserRetentionBudget {
  return {
    limit: readPositiveIntEnv(
      'ORCA_HEADLESS_BROWSER_RESIDENT_LIMIT',
      OFFSCREEN_BROWSER_RESIDENT_LIMIT
    ),
    idleMs: readPositiveIntEnv(
      'ORCA_HEADLESS_BROWSER_PARK_IDLE_MS',
      OFFSCREEN_BROWSER_IDLE_PARK_MS
    ),
    graceMs: readPositiveIntEnv(
      'ORCA_HEADLESS_BROWSER_PARK_GRACE_MS',
      OFFSCREEN_BROWSER_PARK_GRACE_MS
    )
  }
}

/**
 * The earliest time selectBrowserRetentionEvictions could return something new
 * if nothing else happens, or null if only an event can change the answer.
 *
 * Rank changes only when a page is created, woken or closed, and every one of
 * those already re-arms the timer — so the clock only has to cover the idle and
 * grace windows.
 */
export function nextOffscreenBrowserReclaimCheckAt(args: {
  /** Most-recently-used first, matching the selector's ranking. */
  candidates: readonly BrowserRetentionCandidate[]
  isPinned: (id: string) => boolean
  now: number
  budget: BrowserRetentionBudget
}): number | null {
  let next: number | null = null
  const consider = (at: number): void => {
    if (!Number.isFinite(at)) {
      return
    }
    next = next === null ? at : Math.min(next, at)
  }
  args.candidates.forEach((candidate, rank) => {
    if (args.isPinned(candidate.id)) {
      consider(args.now + OFFSCREEN_BROWSER_PINNED_RECHECK_MS)
      return
    }
    if (candidate.lastActivityAt === undefined) {
      return
    }
    if (rank >= args.budget.limit) {
      // Grace is the only thing still holding it resident.
      consider(candidate.lastActivityAt + args.budget.graceMs)
      return
    }
    // Within the limit only the idle window can evict it, and grace still applies.
    consider(candidate.lastActivityAt + Math.max(args.budget.graceMs, args.budget.idleMs))
  })
  return next
}
