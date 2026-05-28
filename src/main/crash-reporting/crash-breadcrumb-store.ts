import {
  sanitizeCrashReportBreadcrumbs,
  type CrashReportBreadcrumb
} from '../../shared/crash-reporting'

const MAX_BREADCRUMBS = 30

let breadcrumbs: CrashReportBreadcrumb[] = []

export function recordCrashBreadcrumb(
  name: string,
  data?: Record<string, string | number | boolean | null>
): void {
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

export function getCrashBreadcrumbSnapshot(): CrashReportBreadcrumb[] {
  return breadcrumbs.map((breadcrumb) => ({
    ...breadcrumb,
    ...(breadcrumb.data ? { data: { ...breadcrumb.data } } : {})
  }))
}

export function clearCrashBreadcrumbsForTest(): void {
  breadcrumbs = []
}
