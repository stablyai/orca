import {
  sanitizeCrashReportDetails,
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import { flushActiveSink, startSpan } from '../observability/tracer'
import { recordCrashBreadcrumb } from './crash-breadcrumb-store'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'

export function recordDurableCrashBreadcrumb(
  name: string,
  data?: CrashReportBreadcrumbData,
  failureCause?: string
): void {
  const sanitizedName = sanitizeCrashReportString(name)
  const sanitizedData = data ? sanitizeCrashReportDetails(data) : {}
  // Why: durable events survive renderer replacement, so carrying the main
  // identity here distinguishes renderer recovery from a true app relaunch.
  const lifecycleData = {
    ...sanitizedData,
    ...getMainProcessLifecycleIdentity()
  }
  recordCrashBreadcrumb(sanitizedName, lifecycleData)

  const span = startSpan('crash.breadcrumb', {
    attributes: {
      kind: 'crash-breadcrumb',
      'breadcrumb.name': sanitizedName,
      'breadcrumb.data': lifecycleData
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
