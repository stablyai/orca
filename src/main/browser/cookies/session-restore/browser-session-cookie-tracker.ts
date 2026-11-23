import type { Cookie, Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import type { ScopeChange } from './browser-session-cookie-scopes'

export type SessionCookieTracker = {
  target: Session
  filePath: string
  /** What the file holds now, by scope. */
  saved: Map<string, CdpCookie[]>
  /** The file may hold cookies `saved` lacks (it could not be read), so the next save must rewrite it. */
  savedStale: boolean
  /** Set until the file has been read: a save before then would compare against nothing. */
  reading: boolean
  /** Scopes whose cookies changed since `saved` was read. */
  changedScopes: Map<string, ScopeChange>
  /** Set while a save reads: scopes that changed meanwhile, which the read may have missed. */
  changedDuringSave: Map<string, ScopeChange> | null
  timer: ReturnType<typeof setTimeout> | null
  /** Settles once the launch restore put the file's cookies back; a clear before then would be undone. */
  restored: Promise<void> | null
  /** The snapshot writes (saves and clears) queued for the file, if any. */
  saving: Promise<void> | null
  onChanged: (event: Electron.Event, cookie: Cookie, cause: string, removed: boolean) => void
}

// Why keyed by file path: the same browser profile id ('default') exists in every Orca profile.
export const sessionCookieTrackers = new Map<string, SessionCookieTracker>()

/** The tracker for a jar whose session cookies this launch tracks, if any. */
export function sessionCookieTrackerFor(target: Session): SessionCookieTracker | undefined {
  return [...sessionCookieTrackers.values()].find((tracker) => tracker.target === target)
}

export function stopTrackingSessionCookies(filePath: string): void {
  const tracker = sessionCookieTrackers.get(filePath)
  if (tracker) {
    cancelPendingSave(tracker)
    tracker.target.cookies.off('changed', tracker.onChanged)
    sessionCookieTrackers.delete(filePath)
  }
}

export function cancelPendingSave(tracker: SessionCookieTracker): void {
  if (tracker.timer) {
    clearTimeout(tracker.timer)
    tracker.timer = null
  }
}

/** Runs a snapshot write after those already queued, so an older one can't land last. */
export function queueSnapshotWrite(
  tracker: SessionCookieTracker,
  write: () => Promise<void>
): Promise<void> {
  const run = (tracker.saving ?? Promise.resolve()).then(write)
  const settled: Promise<void> = run
    .catch(() => {})
    .then(() => {
      if (tracker.saving === settled) {
        tracker.saving = null
      }
    })
  tracker.saving = settled
  return run
}
