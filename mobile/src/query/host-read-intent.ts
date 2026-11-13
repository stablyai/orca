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
 * - `open`: the first read of a screen, or one that only has a copy from an earlier launch; the
 *   host may reuse its own lookup from moments ago.
 * - `foreground`: the app just came back to the foreground; the user is looking again and the
 *   host reads fresh.
 * - `background`: the screen's own timer, which the host may answer from its last read at its PR
 *   auto-refresh cadence, saying when to read again while it revalidates.
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
