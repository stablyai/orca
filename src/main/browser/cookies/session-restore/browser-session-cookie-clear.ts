import type { Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey } from '../browser-cookie-clear-store'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'
import { groupByScope } from './browser-session-cookie-scopes'
import {
  scheduleSave,
  sessionCookieTrackerFor,
  writeTrackedSnapshot
} from './browser-session-cookie-restore'
import { queueSnapshotWrite } from './browser-session-cookie-tracker'

/** Clears every cookie in a jar, durably. */
export async function clearBrowserCookieJar(target: Session): Promise<void> {
  await withCookieMutationLock(target, () => target.clearStorageData({ storages: ['cookies'] }))
  await persistBrowserCookieClear(target)
}

/**
 * For a cookie clear: what it removed leaves Chromium's store and the saved session cookies now,
 * not at their next commit up to 30 s later, so a crash before then can't sign pages back in.
 */
export async function persistBrowserCookieClear(
  target: Session,
  cleared: (cookie: CdpCookie) => boolean = () => true
): Promise<void> {
  await target.cookies.flushStore()
  const tracker = sessionCookieTrackerFor(target)
  if (!tracker) {
    return
  }
  // After any queued save: one that read the jar before the clear would write it back.
  await queueSnapshotWrite(tracker, async () => {
    // A profile deleted meanwhile already lost its file.
    if (sessionCookieTrackerFor(target) !== tracker) {
      return
    }
    const saved = [...tracker.saved.values()].flat()
    const kept = saved.filter((cookie) => !cleared(cookie))
    if (kept.length === saved.length && !tracker.savedStale) {
      return
    }
    try {
      await writeTrackedSnapshot(tracker, kept)
    } catch (error) {
      // The file may still hold what was cleared; the next save rewrites it without that.
      tracker.saved = groupByScope(kept, cdpCookieScopeKey)
      tracker.savedStale = true
      scheduleSave(tracker)
      throw error
    }
  })
}
