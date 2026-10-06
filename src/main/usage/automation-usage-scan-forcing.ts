type AutomationUsageScanAttempts = {
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
}

/**
 * Whether an automation run's usage lookup must force a provider scan.
 *
 * Why: attribution needs one finished scan attempt after the run. Keying on the
 * attempt instead of its outcome bounds this to a single forced scan per run — a
 * persistently failing scan used to re-force on every lookup, forever.
 */
export function shouldForceAutomationUsageScan(
  scanState: AutomationUsageScanAttempts,
  completedAt: number,
  isScanning: boolean
): boolean {
  const { lastScanStartedAt, lastScanCompletedAt } = scanState
  // Why: an in-flight scan's start time is not a finished attempt yet. Counting
  // it sends the lookup down refresh(false), which returns early inside the
  // staleness window instead of joining the scan, so the run reads unavailable.
  // Forcing here only awaits the scan promise the lifecycle already shares.
  const lastFinishedAttempt = isScanning
    ? (lastScanCompletedAt ?? 0)
    : Math.max(lastScanStartedAt ?? 0, lastScanCompletedAt ?? 0)
  return lastFinishedAttempt < completedAt
}
