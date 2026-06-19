import {
  sanitizeCrashReportBreadcrumbs,
  type CrashReportBreadcrumbData,
  type CrashReportBreadcrumb
} from '../../shared/crash-reporting'

const MAX_BREADCRUMBS = 30
// Why: coalesceKey embeds an open-string agentType (length-trimmed only, never
// enum-checked), so the key space is unbounded over a long multi-agent/SSH session.
// Bound the coalesce map the same way ProcessGoneDedupe bounds its key map.
const MAX_COALESCE_KEYS = 128

let breadcrumbs: CrashReportBreadcrumb[] = []
let coalescedBreadcrumbs = new Map<string, { recordedAt: number; suppressed: number }>()

export function recordCrashBreadcrumb(name: string, data?: CrashReportBreadcrumbData): void {
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
  breadcrumbs.push(breadcrumb)
  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs.shift()
  }
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
}): void {
  const now = Date.now()
  const previous = coalescedBreadcrumbs.get(coalesceKey)
  if (previous && now - previous.recordedAt < minIntervalMs) {
    previous.suppressed += 1
    return
  }

  // Drop entries past their suppression window (they can no longer coalesce
  // anything) and LRU-cap the rest. delete-then-set keeps insertion order =
  // recency so only genuinely idle keys are evicted.
  for (const [key, entry] of coalescedBreadcrumbs) {
    if (now - entry.recordedAt >= minIntervalMs) {
      coalescedBreadcrumbs.delete(key)
    }
  }
  coalescedBreadcrumbs.delete(coalesceKey)
  coalescedBreadcrumbs.set(coalesceKey, { recordedAt: now, suppressed: 0 })
  while (coalescedBreadcrumbs.size > MAX_COALESCE_KEYS) {
    const oldest = coalescedBreadcrumbs.keys().next()
    if (oldest.done) {
      break
    }
    coalescedBreadcrumbs.delete(oldest.value)
  }
  recordCrashBreadcrumb(
    name,
    previous?.suppressed ? { ...data, suppressedSinceLast: previous.suppressed } : data
  )
}

export function getCrashBreadcrumbSnapshot(): CrashReportBreadcrumb[] {
  return breadcrumbs.map((breadcrumb) => ({
    ...breadcrumb,
    ...(breadcrumb.data ? { data: { ...breadcrumb.data } } : {})
  }))
}

export function clearCrashBreadcrumbsForTest(): void {
  breadcrumbs = []
  coalescedBreadcrumbs = new Map()
}

export function getCoalescedKeyCountForTest(): number {
  return coalescedBreadcrumbs.size
}
