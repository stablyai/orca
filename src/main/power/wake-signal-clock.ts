// Wake-type signals that could precede a terminal-host folder denial; times only, kept in memory.
// Electron-free: the desktop shell feeds it, and runtime-reachable daemon code reads it.
export type WakeSignal = 'resume' | 'unlock-screen' | 'user-did-become-active'

const lastSeenAtMs = new Map<WakeSignal, number>()

export function recordWakeSignal(signal: WakeSignal, nowMs: number = Date.now()): void {
  lastSeenAtMs.set(signal, nowMs)
}

/** Null when the signal has not fired since this app process started. */
export function msSinceWakeSignal(signal: WakeSignal, nowMs: number): number | null {
  const at = lastSeenAtMs.get(signal)
  return at === undefined ? null : Math.max(0, nowMs - at)
}
