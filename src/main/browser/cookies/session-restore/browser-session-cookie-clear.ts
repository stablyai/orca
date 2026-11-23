import type { Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey } from '../browser-cookie-clear-store'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'
import { groupByScope, liveCookieScopeKey, noteScopeChange } from './browser-session-cookie-scopes'
import { scheduleSave, writeTrackedSnapshot } from './browser-session-cookie-restore'
import {
  queueSnapshotWrite,
  sessionCookieTrackerFor,
  untrackedSnapshotGone
} from './browser-session-cookie-tracker'

/** Clears every cookie in a jar, durably. */
export async function clearBrowserCookieJar(target: Session): Promise<void> {
  await sessionCookieTrackerFor(target)?.restored
  await withCookieMutationLock(target, () => target.clearStorageData({ storages: ['cookies'] }))
  await persistBrowserCookieClear(target)
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
  await target.cookies.flushStore()
  const tracker = sessionCookieTrackerFor(target)
  if (!tracker) {
    return untrackedSnapshotGone(target)
  }
  const cleared = partial ?? (() => true)
  // After any queued save: one that read the jar before the clear would write it back.
  return queueSnapshotWrite(tracker, async () => {
    // Retired meanwhile: only the file's removal shows nothing saved brings the cookies back.
    if (sessionCookieTrackerFor(target) !== tracker) {
      return untrackedSnapshotGone(target)
    }
    if (tracker.savedFile === 'unread' && partial) {
      return false
    }
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
      }
    }
    const wasUnread = tracker.savedFile === 'unread'
    try {
      await writeTrackedSnapshot(tracker, kept)
      if (wasUnread) {
        // Changes went unrecorded while the file was unread: what the jar holds now is new.
        for (const cookie of await target.cookies.get({ session: true })) {
          const key = liveCookieScopeKey(cookie)
          if (key) {
            noteScopeChange(tracker.changedScopes, key, 'other')
          }
        }
      }
      return true
    } catch (error) {
      // The file may still hold what was cleared; the next save (or quit) rewrites it without that.
      tracker.saved = groupByScope(kept, cdpCookieScopeKey)
      tracker.savedFile = 'stale'
      tracker.rewriteRetried = false
      throw error
    } finally {
      scheduleSave(tracker)
    }
  })
}
