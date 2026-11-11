import type { HostQueryRead } from './host-query'

/** The app just came to the foreground: its next reads are the user looking, not a timer. */
export const FOREGROUND_READ_WINDOW_MS = 5_000

let lastForegroundAt = Date.now()

/** Called by the query provider's AppState listener when the app becomes active. */
export function noteAppForegrounded(now = Date.now()): void {
  lastForegroundAt = now
}

export function wasAppForegroundedRecently(now = Date.now()): boolean {
  return now - lastForegroundAt < FOREGROUND_READ_WINDOW_MS
}

/**
 * What a PR read is to the host:
 * - `action`: a Refresh or an action's read; it also re-learns host status.
 * - `open`: the first read of a screen, or one that only has a copy from an earlier launch.
 * - `foreground`: the app just came back to the foreground; the user is looking again.
 * - `background`: the screen's own timer, which the host may answer from its last read at its
 *   PR auto-refresh cadence.
 * Everything but `background` reads fresh in every mode; `foreground` also bypasses the host's
 * short reuse of its own desktop lookup, which exists for a screen opening right after it.
 */
export type HostReadIntent = 'action' | 'open' | 'foreground' | 'background'

export function hostReadIntent(
  read: HostQueryRead,
  previous: unknown,
  recentlyForegrounded: () => boolean = wasAppForegroundedRecently
): HostReadIntent {
  if (read.live) {
    return 'action'
  }
  if (previous === undefined || read.previousFromStore) {
    return 'open'
  }
  return recentlyForegrounded() ? 'foreground' : 'background'
}

export function isBackgroundHostRead(
  read: HostQueryRead,
  previous: unknown,
  recentlyForegrounded: () => boolean = wasAppForegroundedRecently
): boolean {
  return hostReadIntent(read, previous, recentlyForegrounded) === 'background'
}

export function isForegroundHostRead(
  read: HostQueryRead,
  previous: unknown,
  recentlyForegrounded: () => boolean = wasAppForegroundedRecently
): boolean {
  return hostReadIntent(read, previous, recentlyForegrounded) === 'foreground'
}
