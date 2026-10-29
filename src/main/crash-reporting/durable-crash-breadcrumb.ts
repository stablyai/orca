import {
  sanitizeCrashReportDetails,
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import { flushActiveSink, startSpan } from '../observability/tracer'
import { recordCoalescedCrashBreadcrumb, recordCrashBreadcrumb } from './crash-breadcrumb-store'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'

function buildLifecycleData(data?: CrashReportBreadcrumbData): CrashReportBreadcrumbData {
  // Main identity distinguishes renderer replacement from an app relaunch.
  return {
    ...(data ? sanitizeCrashReportDetails(data) : {}),
    ...getMainProcessLifecycleIdentity()
  }
}

function traceDurableBreadcrumb(
  name: string,
  data: CrashReportBreadcrumbData,
  failureCause?: string
): void {
  const span = startSpan('crash.breadcrumb', {
    attributes: {
      kind: 'crash-breadcrumb',
      'breadcrumb.name': name,
      'breadcrumb.data': data
    }
  })
  if (failureCause) {
    span.fail(sanitizeCrashReportString(failureCause, 1_000))
  } else {
    span.end()
  }
  // Flush before a crash can lose the evidence explaining a missing report.
  flushActiveSink()
}

export function recordDurableCrashBreadcrumb(
  name: string,
  data?: CrashReportBreadcrumbData,
  failureCause?: string,
  origin?: string
): void {
  const sanitizedName = sanitizeCrashReportString(name)
  const lifecycleData = buildLifecycleData(data)
  recordCrashBreadcrumb(sanitizedName, lifecycleData, origin)
  traceDurableBreadcrumb(sanitizedName, lifecycleData, failureCause)
}

/** Coalesce durable repeats to avoid a trace span and forced flush for every occurrence. */
export function recordCoalescedDurableCrashBreadcrumb({
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
}): void {
  const sanitizedName = sanitizeCrashReportString(name)
  const lifecycleData = buildLifecycleData(data)
  const coalesced = recordCoalescedCrashBreadcrumb({
    name: sanitizedName,
    data: lifecycleData,
    coalesceKey,
    minIntervalMs,
    ...(origin ? { origin } : {})
  })
  if (!coalesced) {
    return
  }
  traceDurableBreadcrumb(
    sanitizedName,
    coalesced.suppressedSinceLast > 0
      ? { ...lifecycleData, suppressedSinceLast: coalesced.suppressedSinceLast }
      : lifecycleData
  )
}
