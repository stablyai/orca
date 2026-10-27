import { DESKTOP_AWAY_SECONDS } from '../../shared/desktop-away-threshold'

type IdleMonitor = {
  getSystemIdleState(threshold: number): string
  getSystemIdleTime(): number
}

export function readDesktopAwayState(monitor: IdleMonitor): boolean | undefined {
  try {
    const state = monitor.getSystemIdleState(DESKTOP_AWAY_SECONDS)
    if (state === 'locked' || state === 'idle') {
      return true
    }
    const idle = monitor.getSystemIdleTime()
    return Number.isFinite(idle) && idle >= 0 ? idle >= DESKTOP_AWAY_SECONDS : undefined
  } catch {
    // Unknown presence must not silence a phone.
    return undefined
  }
}
