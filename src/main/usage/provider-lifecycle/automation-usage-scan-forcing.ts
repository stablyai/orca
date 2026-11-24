type AutomationUsageScanAttempts = {
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
}

/** Attribution needs one finished scan attempt after the run, regardless of success; outcome-based forcing would retry failing scans forever. */
export function shouldForceAutomationUsageScan(
  scanState: AutomationUsageScanAttempts,
  completedAt: number,
  isScanning: boolean
): boolean {
  const { lastScanStartedAt, lastScanCompletedAt } = scanState
  // An in-flight start is unfinished; force joins its shared promise instead of returning stale data through refresh(false).
  const lastFinishedAttempt = isScanning
    ? (lastScanCompletedAt ?? 0)
    : Math.max(lastScanStartedAt ?? 0, lastScanCompletedAt ?? 0)
  return lastFinishedAttempt < completedAt
}
