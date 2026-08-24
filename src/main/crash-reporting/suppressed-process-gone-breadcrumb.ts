import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import type { ExpectedTeardownScope } from './process-gone-classification'

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function buildSuppressedProcessGoneBreadcrumbData({
  source,
  processType,
  reason,
  exitCode,
  expectedTeardown,
  details,
  webContentsId
}: {
  source: 'renderer' | 'child'
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
  webContentsId?: number
}): CrashReportBreadcrumbData {
  const breadcrumb: CrashReportBreadcrumbData = {
    source,
    processType,
    reason,
    exitCode,
    expectedTeardown
  }
  // Why: names which renderer a suppressed/deduped event belonged to now that
  // several renderers (main window + browser guests) report concurrently.
  if (typeof webContentsId === 'number') {
    breadcrumb.webContentsId = webContentsId
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
