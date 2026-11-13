import { powerMonitor } from 'electron'

// Wake-type signals that could precede a terminal-host folder denial; times only, kept in memory.
export type WakeSignal = 'resume' | 'unlock-screen' | 'user-did-become-active'

const lastSeenAtMs = new Map<WakeSignal, number>()

export function registerWakeSignalClock(): () => void {
  const onResume = (): void => void lastSeenAtMs.set('resume', Date.now())
  const onUnlock = (): void => void lastSeenAtMs.set('unlock-screen', Date.now())
  const onUserActive = (): void => void lastSeenAtMs.set('user-did-become-active', Date.now())
  powerMonitor.on('resume', onResume)
  powerMonitor.on('unlock-screen', onUnlock)
  powerMonitor.on('user-did-become-active', onUserActive)
  return () => {
    powerMonitor.off('resume', onResume)
    powerMonitor.off('unlock-screen', onUnlock)
    powerMonitor.off('user-did-become-active', onUserActive)
  }
}

/** Null when the signal has not fired since this app process started. */
export function msSinceWakeSignal(signal: WakeSignal, nowMs: number): number | null {
  const at = lastSeenAtMs.get(signal)
  return at === undefined ? null : Math.max(0, nowMs - at)
}
