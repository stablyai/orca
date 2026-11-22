import { DESKTOP_AWAY_SECONDS } from '../../shared/app-lifecycle/presence/desktop-away-threshold'
import { watchLinuxSessionLock } from './linux-session-lock'

type IdleMonitor = {
  getSystemIdleState(threshold: number): string
  getSystemIdleTime(): number
}

let linuxSessionLocked = false

export function subscribeDesktopAwayLockChanges(onChange: () => void): () => void {
  const stop = watchLinuxSessionLock((locked) => {
    if (linuxSessionLocked !== locked) {
      linuxSessionLocked = locked
      onChange()
    }
  })
  return () => {
    stop()
    linuxSessionLocked = false
  }
}

export function readDesktopAwayState(monitor: IdleMonitor): boolean | undefined {
  if (linuxSessionLocked) {
    return true
  }
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
