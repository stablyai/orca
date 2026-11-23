import type { Cookie, Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import type { ScopeChange } from './browser-session-cookie-scopes'

export type SessionCookieTracker = {
  target: Session
  filePath: string
  /** What the file holds now, by scope; for 'stale', what it should hold. */
  saved: Map<string, CdpCookie[]>
  /**
   * 'same': the file holds `saved`. 'stale': a clear's write failed, so it may still hold cookies
   * `saved` dropped, and the next save must rewrite it. 'unread': launch could not read it, so
   * `saved` is empty and says nothing of what it holds. Its bytes may read on a later launch, so
   * this launch writes over it only for a full clear (or removes it with the profile).
   */
  savedFile: 'same' | 'stale' | 'unread'
  /** Set once the one timer retry of a failed clear's rewrite has run: later saves write only real changes. */
  rewriteRetried: boolean
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

// A retired jar's file, by jar, and whether its removal finished (true) or failed (false).
const detachedFiles = new WeakMap<Session, string>()
const retirements = new Map<string, Promise<boolean>>()

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
    detachedFiles.set(tracker.target, filePath)
  }
}

/** For a profile or route jar being retired: stops tracking it, then removes its file. */
export function retireSessionCookieSnapshot(
  filePath: string,
  remove: (filePath: string) => Promise<void>
): Promise<void> {
  stopTrackingSessionCookies(filePath)
  const removal = remove(filePath)
  retirements.set(
    filePath,
    removal.then(
      () => true,
      () => false
    )
  )
  return removal
}

/**
 * For a jar no tracker owns: true only when nothing saved can restore its cookies. Not tracking a
 * jar proves nothing, its retirement's removal must have finished, and no newer restore may have
 * read the file since.
 */
export async function untrackedSnapshotGone(target: Session): Promise<boolean> {
  const filePath = detachedFiles.get(target)
  if (filePath === undefined) {
    return true
  }
  const removed = (await retirements.get(filePath)) ?? false
  return removed && !sessionCookieTrackers.has(filePath)
}

export function cancelPendingSave(tracker: SessionCookieTracker): void {
  if (tracker.timer) {
    clearTimeout(tracker.timer)
    tracker.timer = null
  }
}

/** Runs a snapshot write after those already queued, so an older one can't land last. */
export function queueSnapshotWrite<T>(
  tracker: SessionCookieTracker,
  write: () => Promise<T>
): Promise<T> {
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
