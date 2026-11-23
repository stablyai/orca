import { DESKTOP_AWAY_SECONDS } from '../../shared/app-lifecycle/presence/desktop-away-threshold'
import { watchLinuxSessionLock } from './linux-session-lock'
import { watchLinuxWaylandIdle } from './linux-wayland-idle'

type IdleMonitor = {
  getSystemIdleState(threshold: number): string
  getSystemIdleTime(): number
}

let linuxSessionLocked = false
let linuxWaylandIdle: boolean | undefined

export function subscribeDesktopAwayChanges(
  onChange: () => void,
  waylandHelper?: string
): () => void {
  const stopLock = watchLinuxSessionLock((locked) => {
    if (linuxSessionLocked !== locked) {
      linuxSessionLocked = locked
      onChange()
    }
  })
  const stopIdle = waylandHelper
    ? watchLinuxWaylandIdle(waylandHelper, (idle) => {
        if (linuxWaylandIdle !== idle) {
          linuxWaylandIdle = idle
          onChange()
        }
      })
    : undefined
  return () => {
    stopLock()
    stopIdle?.()
    linuxSessionLocked = false
    linuxWaylandIdle = undefined
  }
}

export function readDesktopAwayState(monitor: IdleMonitor): boolean | undefined {
  if (linuxSessionLocked || linuxWaylandIdle === true) {
    return true
  }
  try {
    const state = monitor.getSystemIdleState(DESKTOP_AWAY_SECONDS)
    if (state === 'locked') {
      return true
    }
    if (linuxWaylandIdle === false) {
      return false
    }
    if (state === 'idle') {
      return true
    }
    const idle = monitor.getSystemIdleTime()
    return Number.isFinite(idle) && idle >= 0 ? idle >= DESKTOP_AWAY_SECONDS : undefined
  } catch {
    // Unknown presence must not silence a phone.
    return linuxWaylandIdle
  }
}
