import { DESKTOP_AWAY_SECONDS } from '../../shared/app-lifecycle/presence/desktop-away-threshold'

type IdleMonitor = {
  getSystemIdleState(threshold: number): string
  getSystemIdleTime(): number
}

export function readDesktopAwayState(
  monitor: IdleMonitor,
  thresholdSeconds = DESKTOP_AWAY_SECONDS
): boolean | undefined {
  try {
    const state = monitor.getSystemIdleState(thresholdSeconds)
    if (state === 'locked' || state === 'idle') {
      return true
    }
    const idle = monitor.getSystemIdleTime()
    return Number.isFinite(idle) && idle >= 0 ? idle >= thresholdSeconds : undefined
  } catch {
    // Unknown presence must not silence a phone.
    return undefined
  }
}
