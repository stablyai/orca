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
 * Whether a PR read is the phone's own timer, which the host may answer from its last read at its
 * PR auto-refresh cadence. An action's read, the first read of a screen, a read that only has a
 * copy from an earlier launch, and a read right after the app came to the foreground are the user
 * looking, so they read fresh in every mode.
 */
export function isBackgroundHostRead(
  read: HostQueryRead,
  previous: unknown,
  recentlyForegrounded: () => boolean = wasAppForegroundedRecently
): boolean {
  return !read.live && previous !== undefined && !read.previousFromStore && !recentlyForegrounded()
}
