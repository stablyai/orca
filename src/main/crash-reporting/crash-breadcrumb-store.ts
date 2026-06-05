import {
  sanitizeCrashReportBreadcrumbs,
  type CrashReportBreadcrumbData,
  type CrashReportBreadcrumb
} from '../../shared/crash-reporting'

const MAX_BREADCRUMBS = 30

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

  coalescedBreadcrumbs.set(coalesceKey, { recordedAt: now, suppressed: 0 })
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
