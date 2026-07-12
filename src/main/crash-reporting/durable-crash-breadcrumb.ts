import {
  sanitizeCrashReportDetails,
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import { flushActiveSink, startSpan } from '../observability/tracer'
import { recordCrashBreadcrumb } from './crash-breadcrumb-store'

export function recordDurableCrashBreadcrumb(
  name: string,
  data?: CrashReportBreadcrumbData,
  failureCause?: string
): void {
  const sanitizedName = sanitizeCrashReportString(name)
  const sanitizedData = data ? sanitizeCrashReportDetails(data) : undefined
  recordCrashBreadcrumb(sanitizedName, sanitizedData)

  const span = startSpan('crash.breadcrumb', {
    attributes: {
      kind: 'crash-breadcrumb',
      'breadcrumb.name': sanitizedName,
      ...(sanitizedData ? { 'breadcrumb.data': sanitizedData } : {})
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
