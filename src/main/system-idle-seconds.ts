import { powerMonitor } from 'electron'

type IdleMonitor = {
  getSystemIdleTime: () => number
}

/**
 * Seconds since the last OS-level input, or null when the platform cannot report it.
 *
 * Why the OS clock and not renderer events: browser panes are `<webview>`s in their own
 * process and terminals/editors stop propagation, so renderer listeners miss real activity.
 * Null (Wayland, or a throwing monitor) must read as "unknown", never as "idle".
 */
export function readSystemIdleSeconds(monitor: IdleMonitor = powerMonitor): number | null {
  try {
    const idle = monitor.getSystemIdleTime()
    return Number.isFinite(idle) && idle >= 0 ? idle : null
  } catch {
    return null
  }
}
