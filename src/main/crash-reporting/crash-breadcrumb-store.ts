import {
  sanitizeCrashReportBreadcrumbs,
  sanitizeCrashReportDetails,
  type CrashReportBreadcrumbData,
  type CrashReportBreadcrumb
} from '../../shared/crash-reporting'

const MAX_BREADCRUMBS = 30
// Why: retain two thresholds for each renderer surface without growing the ring.
const MAX_RETAINED_BREADCRUMBS = 4
// Why: coalesceKey embeds an open-string agentType (length-trimmed only, never
// enum-checked), so the key space is unbounded over a long multi-agent/SSH session.
// Bound the coalesce map the same way ProcessGoneDedupe bounds its key map.
const MAX_COALESCE_KEYS = 128

// Why: wall-clock corrections must not stretch or collapse suppression windows.
const monotonicNow = (): number => performance.now()

type CoalescedBreadcrumbState = {
  /** Name needed to materialize unresolved repeats if the owned crumb is orphaned. */
  name: string
  windowStartedAtMs: number
  suppressed: number
  /** Count the crumb was emitted claiming (the previous window's repeats). */
  carried: number
  /** Of `suppressed`, how many a resolve already folded into the crumb, so a
   *  later emit never claims the same repeats a snapshot attributed. */
  resolved: number
  /** Ring entry this key owns, refreshed in place while suppressing. */
  emitted?: CrashReportBreadcrumb
  /** Newest suppressed payload, sanitized only if a snapshot actually asks for it. */
  pending?: CrashReportBreadcrumbData
}

let breadcrumbs: CrashReportBreadcrumb[] = []
let retainedBreadcrumbs = new Map<string, CrashReportBreadcrumb>()
let coalescedBreadcrumbs = new Map<string, CoalescedBreadcrumbState>()

function retainedBreadcrumbKey(breadcrumb: CrashReportBreadcrumb): string | null {
  if (breadcrumb.name !== 'renderer_memory_highwater') {
    return null
  }
  const surface = breadcrumb.data?.rendererSurface
  const threshold = breadcrumb.data?.thresholdPct
  return `${breadcrumb.name}:${String(surface)}:${String(threshold)}`
}

/** Returns the stored breadcrumb so coalescing can refresh the entry it owns. */
export function recordCrashBreadcrumb(
  name: string,
  data?: CrashReportBreadcrumbData
): CrashReportBreadcrumb | undefined {
  const sanitized = sanitizeCrashReportBreadcrumbs([
    {
      createdAt: new Date().toISOString(),
      name,
      data
    }
  ])
  const breadcrumb = sanitized?.[0]
  if (!breadcrumb) {
    return
  }
  const retainedKey = retainedBreadcrumbKey(breadcrumb)
  if (retainedKey) {
    retainedBreadcrumbs.delete(retainedKey)
    retainedBreadcrumbs.set(retainedKey, breadcrumb)
    while (retainedBreadcrumbs.size > MAX_RETAINED_BREADCRUMBS) {
      const oldestKey = retainedBreadcrumbs.keys().next()
      if (oldestKey.done) {
        break
      }
      retainedBreadcrumbs.delete(oldestKey.value)
    }
    return breadcrumb
  }
  breadcrumbs.push(breadcrumb)
  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs.shift()
  }
  return breadcrumb
}

export function recordCoalescedCrashBreadcrumb({
  name,
  data,
  coalesceKey,
  minIntervalMs
}: {
  name: string
  data?: CrashReportBreadcrumbData
  coalesceKey: string
  minIntervalMs: number
}): { suppressedSinceLast: number } | undefined {
  const now = monotonicNow()
  const previous = coalescedBreadcrumbs.get(coalesceKey)
  if (previous && now - previous.windowStartedAtMs < minIntervalMs) {
    previous.suppressed += 1
    // Stash the newest payload for the entry this key already owns: the burst
    // still costs exactly one ring slot, but the retained crumb ends up
    // describing the latest event plus a running count instead of freezing the
    // first. Without this, a burst that grows (pane 1 exhausts, then 33 more)
    // leaves a census reading `livePanes: 1` — the "one pane looping" misread
    // this coalescing was built to prevent. Sanitizing here would put that cost
    // on every suppressed hit of a 1459/min crash loop; the snapshot resolves it
    // once instead, on the rare path that actually reads breadcrumbs.
    previous.pending = data
    // A hot key stays LRU-recent without renewing its fixed suppression window.
    coalescedBreadcrumbs.delete(coalesceKey)
    coalescedBreadcrumbs.set(coalesceKey, previous)
    return undefined
  }

  // Drop entries past their suppression window (they can no longer coalesce
  // anything) and LRU-cap the rest. delete-then-set keeps insertion order =
  // recency so only genuinely idle keys are evicted. Resolve first: an expiring
  // key is about to lose its only handle on the ring entry it owns.
  for (const [key, entry] of coalescedBreadcrumbs) {
    if (now - entry.windowStartedAtMs >= minIntervalMs) {
      // Why the key check: this key is about to emit a fresh crumb carrying
      // `suppressedSinceLast`, so folding the same events into its old slot
      // too would report one burst twice.
      if (key !== coalesceKey) {
        preservePendingCoalescedBreadcrumb(entry)
      }
      coalescedBreadcrumbs.delete(key)
    }
  }
  coalescedBreadcrumbs.delete(coalesceKey)
  // Claim only repeats no resolve has already folded into the previous crumb —
  // a snapshot mid-window attributes them there, and forensic totals must not
  // count one burst twice.
  const suppressedSinceLast = previous ? previous.suppressed - previous.resolved : 0
  const state: CoalescedBreadcrumbState = {
    name,
    windowStartedAtMs: now,
    suppressed: 0,
    carried: suppressedSinceLast,
    resolved: 0
  }
  coalescedBreadcrumbs.set(coalesceKey, state)
  while (coalescedBreadcrumbs.size > MAX_COALESCE_KEYS) {
    const oldest = coalescedBreadcrumbs.entries().next()
    if (oldest.done) {
      break
    }
    preservePendingCoalescedBreadcrumb(oldest.value[1])
    coalescedBreadcrumbs.delete(oldest.value[0])
  }
  state.emitted = recordCrashBreadcrumb(
    name,
    suppressedSinceLast > 0 ? { ...data, suppressedSinceLast } : data
  )
  return { suppressedSinceLast }
}

/** Whether any future snapshot can still include this crumb. The ring only
 *  appends and the retained map only grows toward its cap, so an entry pushed
 *  past the snapshot budget is invisible forever, not just for now. */
function isCoalescedCrumbStillInEvidence(crumb: CrashReportBreadcrumb): boolean {
  const visibleFrom = breadcrumbs.length - (MAX_BREADCRUMBS - retainedBreadcrumbs.size)
  const index = breadcrumbs.indexOf(crumb)
  if (index !== -1 && index >= visibleFrom) {
    return true
  }
  for (const retained of retainedBreadcrumbs.values()) {
    if (retained === crumb) {
      return true
    }
  }
  return false
}

/** Fold a key's newest suppressed payload into the ring entry it owns. */
function resolvePendingCoalescedBreadcrumb(state: CoalescedBreadcrumbState): void {
  // `data` is optional, so the count—not pending payload presence—marks unresolved work.
  if (!state.emitted || state.suppressed <= state.resolved) {
    return
  }
  // Eviction can orphan the crumb mid-window; folding into it would mark the
  // repeats resolved into evidence no snapshot can see, and the next emit would
  // then claim nothing — the burst vanishes from the record entirely. Drop the
  // handle (keeping `resolved` for folds that landed while it was live) so a
  // later emit or bounded cleanup can materialize the unclaimed repeats.
  if (!isCoalescedCrumbStillInEvidence(state.emitted)) {
    state.emitted = undefined
    return
  }
  // The crumb's claim is a running total: what it was born claiming plus every
  // repeat folded since. Dropping `carried` would erase the previous window's
  // count from the record; omitting `resolved` bookkeeping would let the next
  // emit claim these repeats a second time.
  state.emitted.data = sanitizeCrashReportDetails({
    ...state.pending,
    suppressedSinceLast: state.carried + state.suppressed
  })
  state.resolved = state.suppressed
  state.pending = undefined
}

/** Resolve into the owned crumb, or emit the unclaimed repeats before bounded
 *  cleanup drops an orphan's last accounting state. */
function preservePendingCoalescedBreadcrumb(state: CoalescedBreadcrumbState): void {
  resolvePendingCoalescedBreadcrumb(state)
  const unresolved = state.suppressed - state.resolved
  if (state.emitted || unresolved <= 0) {
    return
  }
  recordCrashBreadcrumb(state.name, {
    ...state.pending,
    suppressedSinceLast: unresolved
  })
  state.resolved = state.suppressed
  state.pending = undefined
}

function resolveAllPendingCoalescedBreadcrumbs(): void {
  for (const state of coalescedBreadcrumbs.values()) {
    resolvePendingCoalescedBreadcrumb(state)
  }
}

export function getCrashBreadcrumbSnapshot(): CrashReportBreadcrumb[] {
  resolveAllPendingCoalescedBreadcrumbs()
  // Why: long sessions must retain threshold profiles without growing the 30-entry budget.
  const retained = [...retainedBreadcrumbs.values()]
  const recent = breadcrumbs.slice(-(MAX_BREADCRUMBS - retained.length))
  return [...retained, ...recent]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((breadcrumb) => ({
      ...breadcrumb,
      ...(breadcrumb.data ? { data: { ...breadcrumb.data } } : {})
    }))
}

export function clearCrashBreadcrumbsForTest(): void {
  breadcrumbs = []
  retainedBreadcrumbs = new Map()
  coalescedBreadcrumbs = new Map()
}

export function getCoalescedKeyCountForTest(): number {
  return coalescedBreadcrumbs.size
}
