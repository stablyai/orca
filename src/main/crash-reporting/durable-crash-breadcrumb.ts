import {
  sanitizeCrashReportDetails,
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import { flushActiveSink, startSpan } from '../observability/tracer'
import { recordCoalescedCrashBreadcrumb, recordCrashBreadcrumb } from './crash-breadcrumb-store'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'

function buildLifecycleData(data?: CrashReportBreadcrumbData): CrashReportBreadcrumbData {
  // Why: durable events survive renderer replacement, so carrying the main
  // identity here distinguishes renderer recovery from a true app relaunch.
  return {
    ...(data ? sanitizeCrashReportDetails(data) : {}),
    ...getMainProcessLifecycleIdentity()
  }
}

/** Stamped on every traced durable crumb so a later launch can tell "this build
 *  never wrote `main_process_quit_committed`" from "it wrote one and it is missing".
 *  Trace-only: the in-report breadcrumb ring stays free of reader bookkeeping. */
export const DURABLE_CRASH_BREADCRUMB_SCHEMA = 1

function traceDurableBreadcrumb(
  name: string,
  data: CrashReportBreadcrumbData,
  failureCause?: string
): void {
  const span = startSpan('crash.breadcrumb', {
    attributes: {
      kind: 'crash-breadcrumb',
      'breadcrumb.name': name,
      'breadcrumb.data': data,
      'breadcrumb.schema': DURABLE_CRASH_BREADCRUMB_SCHEMA
    }
  })
  if (failureCause) {
    span.fail(sanitizeCrashReportString(failureCause, 1_000))
  } else {
    span.end()
  }
  // Why: these breadcrumbs explain a missing crash record; losing one to the
  // normal trace batching window would recreate the diagnostic blind spot.
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

/** Durable counterpart to `recordCoalescedCrashBreadcrumb`: identical repeats
 *  inside `minIntervalMs` collapse into the next emitted breadcrumb's
 *  `suppressedSinceLast` instead of each costing a span plus a forced flush. */
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
