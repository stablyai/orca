import type { CrashReportBreadcrumbData } from '../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'

export function recordUpdaterLifecycle(
  event: string,
  data?: CrashReportBreadcrumbData,
  options?: { level?: 'info' | 'warn' | 'error'; message?: string }
): void {
  // Persist update relaunches alongside renderer recovery so support can distinguish them.
  recordDurableCrashBreadcrumb(`updater_${event}`, data)
  const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : ''
  console[options?.level ?? 'info'](`[updater] ${options?.message ?? event}${suffix}`)
}
