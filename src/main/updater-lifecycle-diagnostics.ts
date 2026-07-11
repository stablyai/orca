import type { CrashReportBreadcrumbData } from '../shared/crash-reporting'
import { recordCrashBreadcrumb } from './crash-reporting/crash-breadcrumb-store'

export function recordUpdaterLifecycle(
  event: string,
  data?: CrashReportBreadcrumbData,
  options?: { level?: 'info' | 'warn' | 'error'; message?: string }
): void {
  recordCrashBreadcrumb(`updater_${event}`, data)
  const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : ''
  console[options?.level ?? 'info'](`[updater] ${options?.message ?? event}${suffix}`)
}
