import { getCrashBreadcrumbSnapshot } from '../crash-reporting/crash-breadcrumb-store'

export function collectTerminalLifecycleDiagnosticTrace(): Record<string, unknown> {
  const breadcrumbs = getCrashBreadcrumbSnapshot().filter(
    (breadcrumb) => breadcrumb.name === 'terminal_lifecycle_anomaly'
  )
  return {
    breadcrumbs
  }
}
