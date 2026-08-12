import type { CrashReportBreadcrumbData } from '../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'

export function recordUpdaterLifecycle(
  event: string,
  data?: CrashReportBreadcrumbData,
  options?: { level?: 'info' | 'warn' | 'error'; message?: string }
): void {
  // Why: update-driven relaunches must remain visible in the same durable lane
  // as renderer recovery so support traces can distinguish their lifecycles.
  recordDurableCrashBreadcrumb(`updater_${event}`, data)
  const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : ''
  console[options?.level ?? 'info'](`[updater] ${options?.message ?? event}${suffix}`)
}
