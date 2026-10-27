import {
  sanitizeCrashReportBreadcrumbs,
  sanitizeCrashReportDetails,
  type CrashReportBreadcrumbData,
  type CrashReportBreadcrumb
} from '../../shared/crash-reporting'

const MAX_BREADCRUMBS = 30
const MAX_RETAINED_BREADCRUMBS = 10
export const RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB = 'renderer_heap_allocation_profile'
// Keys include arbitrary agent types, so cap the map for long multi-agent/SSH sessions.
const MAX_COALESCE_KEYS = 128

// Wall-clock corrections must not alter suppression windows.
const monotonicNow = (): number => performance.now()

type CoalescedBreadcrumbState = {
  /** Name needed to materialize unresolved repeats if the owned crumb is orphaned. */
  name: string
  windowStartedAtMs: number
  suppressed: number
  /** Count the crumb was emitted claiming (the previous window's repeats). */
  carried: number
  /** Repeats already attributed to the old entry, excluded from the next emission. */
  resolved: number
  /** Ring entry this key owns, refreshed in place while suppressing. */
  emitted?: CrashReportBreadcrumb
  /** Newest suppressed payload, sanitized only if a snapshot actually asks for it. */
  pending?: CrashReportBreadcrumbData
  origin?: string
}

let breadcrumbs: CrashReportBreadcrumb[] = []
let retainedBreadcrumbs = new Map<string, CrashReportBreadcrumb>()
let coalescedBreadcrumbs = new Map<string, CoalescedBreadcrumbState>()

function retainedBreadcrumbKey(breadcrumb: CrashReportBreadcrumb): string | null {
  if (breadcrumb.name === RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB) {
    // Retain allocation profiles across ring rotations until a possible later OOM.
    return `${breadcrumb.name}:${String(breadcrumb.data?.rendererSurface)}:${breadcrumb.origin ?? 'global'}`
  }
  if (breadcrumb.name !== 'renderer_memory_highwater') {
    return null
  }
  const surface = breadcrumb.data?.rendererSurface
  // Heap ratios and private-memory thresholds are separate ladders; keep their keys distinct.
  const threshold =
    breadcrumb.data?.thresholdPct !== undefined
      ? `pct${String(breadcrumb.data.thresholdPct)}`
      : `privMB${String(breadcrumb.data?.thresholdPrivateMB)}`
  return `${breadcrumb.name}:${String(surface)}:${threshold}:${breadcrumb.origin ?? 'global'}`
}

/** Returns the stored breadcrumb so coalescing can refresh the entry it owns. */
export function recordCrashBreadcrumb(
  name: string,
  data?: CrashReportBreadcrumbData,
  origin?: string
): CrashReportBreadcrumb | undefined {
  const sanitized = sanitizeCrashReportBreadcrumbs([
    {
      createdAt: new Date().toISOString(),
      name,
      data,
      ...(origin ? { origin } : {})
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
    breadcrumbs.splice(evictionIndex(breadcrumbs), 1)
  }
  return breadcrumb
}

function evictionGroupKey(entry: CrashReportBreadcrumb): string {
  // Group by reporter origin so a busy surface cannot evict another surface's lifecycle trail.
  return `${entry.name}\u0000${entry.origin ?? ''}`
}

function ownsUnresolvedRepeats(entry: CrashReportBreadcrumb): boolean {
  for (const state of coalescedBreadcrumbs.values()) {
    if (state.emitted === entry && state.suppressed > state.resolved) {
      return true
    }
  }
  return false
}

/** Evict from the busiest group so periodic events cannot crowd out lifecycle evidence. */
function evictionIndex(ring: CrashReportBreadcrumb[]): number {
  const counts = new Map<string, number>()
  for (const entry of ring) {
    const key = evictionGroupKey(entry)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let crowdedKey = ''
  let crowdedCount = 0
  for (const entry of ring) {
    const key = evictionGroupKey(entry)
    const count = counts.get(key) ?? 0
    // Keep the first maximum so tied groups evict the oldest entry first.
    if (count > crowdedCount) {
      crowdedKey = key
      crowdedCount = count
    }
  }
  let oldestOfGroup = 0
  let foundGroup = false
  // The newest entry has not yet been linked to its coalescing owner.
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (evictionGroupKey(ring[index]) !== crowdedKey) {
      continue
    }
    if (!foundGroup) {
      oldestOfGroup = index
      foundGroup = true
    }
    // Preserve unresolved repeats when another entry in this group can be evicted instead.
    if (!ownsUnresolvedRepeats(ring[index])) {
      return index
    }
  }
  return oldestOfGroup
}

export function recordCoalescedCrashBreadcrumb({
  name,
  data,
  coalesceKey,
  minIntervalMs,
  origin
}: {
  name: string
  data?: CrashReportBreadcrumbData
  coalesceKey: string
  minIntervalMs: number
  origin?: string
}): { suppressedSinceLast: number } | undefined {
  const now = monotonicNow()
  const previous = coalescedBreadcrumbs.get(coalesceKey)
  if (previous && now - previous.windowStartedAtMs < minIntervalMs) {
    previous.suppressed += 1
    // Keep the latest suppressed payload; sanitize only when a snapshot needs it.
    previous.pending = data
    // A hot key stays LRU-recent without renewing its fixed suppression window.
    coalescedBreadcrumbs.delete(coalesceKey)
    coalescedBreadcrumbs.set(coalesceKey, previous)
    return undefined
  }

  // Preserve pending repeats before expiry or the LRU cap removes their accounting state.
  for (const [key, entry] of coalescedBreadcrumbs) {
    if (now - entry.windowStartedAtMs >= minIntervalMs) {
      // This key's next emission claims its repeats; folding them into the old entry would double-count.
      if (key !== coalesceKey) {
        preservePendingCoalescedBreadcrumb(entry)
      }
      coalescedBreadcrumbs.delete(key)
    }
  }
  coalescedBreadcrumbs.delete(coalesceKey)
  // Snapshots may already own repeats; carry forward only those not attributed to the old entry.
  const suppressedSinceLast = previous ? previous.suppressed - previous.resolved : 0
  const state: CoalescedBreadcrumbState = {
    name,
    windowStartedAtMs: now,
    suppressed: 0,
    carried: suppressedSinceLast,
    resolved: 0,
    ...(origin ? { origin } : {})
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
    suppressedSinceLast > 0 ? { ...data, suppressedSinceLast } : data,
    origin
  )
  return { suppressedSinceLast }
}

/** Check the report budget, not just ring membership, before attributing repeats. */
function isCoalescedCrumbStillInEvidence(
  crumb: CrashReportBreadcrumb,
  reporterOrigin?: string
): boolean {
  const retained = [...retainedBreadcrumbs.values()].filter((breadcrumb) =>
    isVisibleToReporter(breadcrumb, reporterOrigin)
  )
  if (retained.some((retainedBreadcrumb) => retainedBreadcrumb === crumb)) {
    return true
  }
  const visibleRecent = breadcrumbs.filter((breadcrumb) =>
    isVisibleToReporter(breadcrumb, reporterOrigin)
  )
  return visibleReportWindow(visibleRecent, MAX_BREADCRUMBS - retained.length).some(
    (recentBreadcrumb) => recentBreadcrumb === crumb
  )
}

/** Apply fair eviction within the reduced budget too, preserving the lifecycle trail. */
function visibleReportWindow(
  visibleRecent: CrashReportBreadcrumb[],
  budget: number
): CrashReportBreadcrumb[] {
  if (visibleRecent.length <= budget) {
    return visibleRecent
  }
  const window = [...visibleRecent]
  while (window.length > budget) {
    window.splice(evictionIndex(window), 1)
  }
  return window
}

function resolvePendingCoalescedBreadcrumb(
  state: CoalescedBreadcrumbState,
  reporterOrigin?: string
): void {
  // Optional data cannot signal pending work; the unresolved count does.
  if (!state.emitted || state.suppressed <= state.resolved) {
    return
  }
  // Keep hidden repeats unresolved so a later emission or cleanup can preserve them.
  if (!isCoalescedCrumbStillInEvidence(state.emitted, reporterOrigin)) {
    state.emitted = undefined
    return
  }
  // Preserve prior-window counts and mark this window resolved to avoid losing or recounting repeats.
  state.emitted.data = sanitizeCrashReportDetails({
    ...state.pending,
    suppressedSinceLast: state.carried + state.suppressed
  })
  state.resolved = state.suppressed
  state.pending = undefined
}

/** Materialize orphaned repeats before bounded cleanup loses their accounting state. */
function preservePendingCoalescedBreadcrumb(state: CoalescedBreadcrumbState): void {
  resolvePendingCoalescedBreadcrumb(state, state.origin)
  const unresolved = state.suppressed - state.resolved
  if (state.emitted || unresolved <= 0) {
    return
  }
  recordCrashBreadcrumb(
    state.name,
    { ...state.pending, suppressedSinceLast: unresolved },
    state.origin
  )
  state.resolved = state.suppressed
  state.pending = undefined
}

function resolveAllPendingCoalescedBreadcrumbs(reporterOrigin?: string): void {
  for (const state of coalescedBreadcrumbs.values()) {
    if (reporterOrigin && state.origin && state.origin !== reporterOrigin) {
      continue
    }
    resolvePendingCoalescedBreadcrumb(state, reporterOrigin)
  }
}

function isVisibleToReporter(
  breadcrumb: CrashReportBreadcrumb,
  reporterOrigin: string | undefined
): boolean {
  return !reporterOrigin || !breadcrumb.origin || breadcrumb.origin === reporterOrigin
}

export function getCrashBreadcrumbSnapshot(reporterOrigin?: string): CrashReportBreadcrumb[] {
  resolveAllPendingCoalescedBreadcrumbs(reporterOrigin)
  const retained = [...retainedBreadcrumbs.values()].filter((breadcrumb) =>
    isVisibleToReporter(breadcrumb, reporterOrigin)
  )
  const visibleRecent = breadcrumbs.filter((breadcrumb) =>
    isVisibleToReporter(breadcrumb, reporterOrigin)
  )
  const recent = visibleReportWindow(visibleRecent, MAX_BREADCRUMBS - retained.length)
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
