import type { Cookie, Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey } from '../browser-cookie-clear-store'
import { groupByScope, type ScopeChange } from './browser-session-cookie-scopes'
import { writeSessionCookieSnapshot } from './browser-session-cookie-snapshot-file'

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
  /**
   * Scopes whose saved cookies launch could not put back in the jar. A live read can't show them,
   * so they stay as saved until a cookie event there proves a real change.
   */
  unrestored: Set<string>
  /** Scopes whose cookies changed since `saved` was read. */
  changedScopes: Map<string, ScopeChange>
  /** Set while a save reads: scopes that changed meanwhile, which the read may have missed. */
  changedDuringSave: Map<string, ScopeChange> | null
  timer: ReturnType<typeof setTimeout> | null
  /** Settles once the launch restore put the file's cookies back; a clear before then would be undone. */
  restored: Promise<void> | null
  /** Set once the jar was retired: true when that retirement removed the file. */
  retired: Promise<boolean> | null
  /** The snapshot writes (saves and clears) queued for the file, if any. */
  saving: Promise<void> | null
  onChanged: (event: Electron.Event, cookie: Cookie, cause: string, removed: boolean) => void
}

// Why keyed by file path: the same browser profile id ('default') exists in every Orca profile.
export const sessionCookieTrackers = new Map<string, SessionCookieTracker>()

// A retired tracker, by jar, so a clear admitted before the retirement can await its receipt.
const retiredTrackers = new WeakMap<Session, SessionCookieTracker>()
// A file's removal still running, so a later tracker for the same file starts after it.
const pendingRemovals = new Map<string, Promise<void>>()

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

/**
 * For a profile or route jar being retired: stops tracking it, then removes its file after the
 * writes already queued for it, so none lands after the removal. A later tracker for the same file
 * reads and writes only once the removal has finished.
 */
export function retireSessionCookieSnapshot(
  filePath: string,
  remove: (filePath: string) => Promise<void>
): Promise<void> {
  const tracker = sessionCookieTrackers.get(filePath)
  stopTrackingSessionCookies(filePath)
  const before = Promise.all([tracker?.saving, pendingRemovals.get(filePath)])
  const removal = before.then(() => remove(filePath))
  const settled = removal.then(
    () => {},
    () => {}
  )
  pendingRemovals.set(filePath, settled)
  void settled.then(() => {
    if (pendingRemovals.get(filePath) === settled) {
      pendingRemovals.delete(filePath)
    }
  })
  if (tracker) {
    tracker.saved = new Map()
    tracker.retired = removal.then(
      () => true,
      () => false
    )
    retiredTrackers.set(tracker.target, tracker)
  }
  return removal
}

/** The tracker a clear on this jar answers to: the current one, else the one retired last. */
export function admittedSessionCookieTracker(target: Session): SessionCookieTracker | undefined {
  return sessionCookieTrackerFor(target) ?? retiredTrackers.get(target)
}

/** Settles once a retirement's removal of this file has finished, if one is running. */
export function pendingSnapshotRemoval(filePath: string): Promise<void> | undefined {
  return pendingRemovals.get(filePath)
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

/** Writes the file, then records what it holds: a failed write must leave the next save something to write. */
export async function writeTrackedSnapshot(
  tracker: SessionCookieTracker,
  cookies: CdpCookie[]
): Promise<void> {
  await writeSessionCookieSnapshot(tracker.filePath, cookies)
  tracker.saved = groupByScope(cookies, cdpCookieScopeKey)
  tracker.savedFile = 'same'
}
