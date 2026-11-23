import type { Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey } from '../browser-cookie-clear-store'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'
import { groupByScope, noteScopeChange } from './browser-session-cookie-scopes'
import { scheduleSave, writeTrackedSnapshot } from './browser-session-cookie-restore'
import { queueSnapshotWrite, sessionCookieTrackerFor } from './browser-session-cookie-tracker'

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
 * saved cookies may still hold what was cleared: a partial clear can't edit a file launch could
 * not read, and dropping it would sign every other site out.
 */
export async function persistBrowserCookieClear(
  target: Session,
  partial?: (cookie: CdpCookie) => boolean
): Promise<boolean> {
  await target.cookies.flushStore()
  const tracker = sessionCookieTrackerFor(target)
  if (!tracker) {
    return true
  }
  const cleared = partial ?? (() => true)
  // After any queued save: one that read the jar before the clear would write it back.
  return queueSnapshotWrite(tracker, async () => {
    // A profile deleted meanwhile already lost its file.
    if (sessionCookieTrackerFor(target) !== tracker) {
      return true
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
    try {
      await writeTrackedSnapshot(tracker, kept)
      return true
    } catch (error) {
      // The file may still hold what was cleared; the next save (or quit) rewrites it without that.
      tracker.saved = groupByScope(kept, cdpCookieScopeKey)
      tracker.savedFile = 'stale'
      tracker.rewriteAttempts = 0
      throw error
    } finally {
      scheduleSave(tracker)
    }
  })
}
