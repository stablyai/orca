export const MOBILE_NOTIFICATION_AWAY_SECONDS = 180

type IdleMonitor = {
  getSystemIdleState(threshold: number): string
  getSystemIdleTime(): number
}

export function readDesktopAwayState(monitor: IdleMonitor): boolean | undefined {
  try {
    const state = monitor.getSystemIdleState(MOBILE_NOTIFICATION_AWAY_SECONDS)
    if (state === 'locked' || state === 'idle') {
      return true
    }
    const idle = monitor.getSystemIdleTime()
    return Number.isFinite(idle) && idle >= 0 ? idle >= MOBILE_NOTIFICATION_AWAY_SECONDS : undefined
  } catch {
    // Unknown presence must not silence a phone.
    return undefined
  }
}
