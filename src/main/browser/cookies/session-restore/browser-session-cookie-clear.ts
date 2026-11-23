import type { Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey } from '../browser-cookie-clear-store'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'
import { groupByScope, liveCookieScopeKey, noteScopeChange } from './browser-session-cookie-scopes'
import { scheduleSave } from './browser-session-cookie-restore'
import {
  admittedSessionCookieTracker,
  queueSnapshotWrite,
  writeTrackedSnapshot,
  type SessionCookieTracker
} from './browser-session-cookie-tracker'

/** Clears every cookie in a jar, durably; throws when the saved cookies may still restore them. */
export async function clearBrowserCookieJar(target: Session): Promise<void> {
  await admittedSessionCookieTracker(target)?.restored
  await withCookieMutationLock(target, () => target.clearStorageData({ storages: ['cookies'] }))
  if (!(await persistBrowserCookieClear(target))) {
    throw new Error('browser_cookie_clear_not_persisted')
  }
}

/**
 * For a cookie clear: what it removed leaves Chromium's store and the saved session cookies now,
 * not at their next commit up to 30 s later, so a crash before then can't sign pages back in.
 * `partial` picks what a partial clear removed; a full clear omits it. Resolves false when the
 * saved cookies may still hold what was cleared: a partial clear can't edit a file this launch
 * could not read (dropping it would sign every other site out), and a retired jar's file may not
 * be gone.
 */
export async function persistBrowserCookieClear(
  target: Session,
  partial?: (cookie: CdpCookie) => boolean
): Promise<boolean> {
  // Admitted now, before the native flush, so a quit or retirement that starts later is ordered
  // after this clear, and the answer comes from the tracker that held the jar when it ran.
  const tracker = admittedSessionCookieTracker(target)
  if (!tracker) {
    // Never tracked this launch: no saved file restores into this jar.
    await target.cookies.flushStore()
    return true
  }
  const result = await queueSnapshotWrite(tracker, () => commitClear(tracker, partial))
  // Outside the queue: the retirement's removal is queued after this clear.
  return result === 'retired' ? ((await tracker.retired) ?? false) : result
}

async function commitClear(
  tracker: SessionCookieTracker,
  partial: ((cookie: CdpCookie) => boolean) | undefined
): Promise<boolean | 'retired'> {
  await tracker.target.cookies.flushStore()
  // Retired: only its removal of the file shows nothing saved brings the cookies back.
  if (tracker.retired) {
    return 'retired'
  }
  if (tracker.savedFile === 'unread' && partial) {
    return false
  }
  const cleared = partial ?? (() => true)
  const saved = [...tracker.saved.values()].flat()
  const kept = saved.filter((cookie) => !cleared(cookie))
  if (kept.length === saved.length && tracker.savedFile === 'same') {
    return true
  }
  // A site may have set one of these again after the clear: the next save reads them back.
  for (const cookie of saved) {
    const key = cleared(cookie) ? cdpCookieScopeKey(cookie) : null
    if (key) {
      noteScopeChange(tracker.changedScopes, key, 'other')
      tracker.unrestored.delete(key)
    }
  }
  const wasUnread = tracker.savedFile === 'unread'
  try {
    await writeTrackedSnapshot(tracker, kept)
  } catch (error) {
    // The file may still hold what was cleared; the next save (or quit) rewrites it without that.
    tracker.saved = groupByScope(kept, cdpCookieScopeKey)
    tracker.savedFile = 'stale'
    tracker.rewriteRetried = false
    scheduleSave(tracker)
    throw error
  }
  // Committed. Changes went unrecorded while the file was unread, so what the jar holds now is
  // new; a failure to read it doesn't undo the clear.
  if (wasUnread) {
    try {
      for (const cookie of await tracker.target.cookies.get({ session: true })) {
        const key = liveCookieScopeKey(cookie)
        if (key) {
          noteScopeChange(tracker.changedScopes, key, 'other')
        }
      }
    } catch (error) {
      console.warn('[browser-session-cookies] Could not read cookies after a clear:', error)
    }
  }
  scheduleSave(tracker)
  return true
}
