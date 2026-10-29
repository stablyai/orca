import { getAppEnvironment, hasAppEnvironment } from '../shared/app-environment'
import { recordCoalescedDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'

/**
 * Guard Windows PID-based kills; stale metrics must not prevent root termination through its handle.
 * Missing metrics leave other kill guards responsible: refusing all kills would leak managed processes.
 * Daemon/Node hosts have no Chromium metrics and instead classify targets against their own ancestry.
 */
export function readOrcaChromiumProcessPids(): ReadonlySet<number> {
  if (!hasAppEnvironment()) {
    return new Set()
  }
  try {
    const pids = getAppEnvironment()
      .getAppMetrics()
      .map((metric) => metric.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    return new Set(pids)
  } catch (error) {
    recordUnreadableOwnChromiumMetrics(error)
    return new Set()
  }
}

// Repeated kill attempts must not flood the shared breadcrumb ring when metrics remain unreadable.
const UNREADABLE_METRICS_COALESCE_MS = 60_000

function recordUnreadableOwnChromiumMetrics(error: unknown): void {
  try {
    recordCoalescedDurableCrashBreadcrumb({
      name: 'own_chromium_pids_unreadable',
      data: { cause: error instanceof Error ? error.message : String(error) },
      coalesceKey: 'own-chromium-pids-unreadable',
      minIntervalMs: UNREADABLE_METRICS_COALESCE_MS
    })
  } catch {
    // Diagnostic failures must not interrupt callers’ termination paths.
  }
}
