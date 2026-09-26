import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import type { ExpectedTeardownScope } from './process-gone-classification'

// Why: the coalesce map prunes every key against the calling window, so a shorter
// one here would weaken the other 30s coalescers. Stay uniform with them.
export const SUPPRESSED_PROCESS_GONE_COALESCE_MS = 30_000

// Why: key off the emitted breadcrumb, not the crash-report dedupe key, so two
// different recoverable services can never suppress each other's evidence.
export function suppressedProcessGoneCoalesceKey(data: CrashReportBreadcrumbData): string {
  return JSON.stringify([
    data.source,
    data.processType,
    data.reason,
    data.exitCode,
    data.expectedTeardown,
    data.serviceName ?? null,
    data.name ?? null,
    data.type ?? null
  ])
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function buildSuppressedProcessGoneBreadcrumbData({
  source,
  processType,
  reason,
  exitCode,
  expectedTeardown,
  details
}: {
  source: 'renderer' | 'child'
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
}): CrashReportBreadcrumbData {
  const breadcrumb: CrashReportBreadcrumbData = {
    source,
    processType,
    reason,
    exitCode,
    expectedTeardown
  }
  const name = safeString(details.name)
  if (name) {
    breadcrumb.name = name
  }
  const serviceName = safeString(details.serviceName)
  if (serviceName) {
    breadcrumb.serviceName = serviceName
  }
  const type = safeString(details.type)
  if (type) {
    breadcrumb.type = type
  }
  return breadcrumb
}
