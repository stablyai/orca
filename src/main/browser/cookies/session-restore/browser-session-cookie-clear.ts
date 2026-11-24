import { session, type Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey } from '../browser-cookie-clear-store'
import {
  withCookieImportSourceLock,
  withCookieMutationLock
} from '../mutation/cookie-mutation-lock'
import { groupByScope, noteScopeChange } from './browser-session-cookie-scopes'
import { scheduleSave, writeTrackedSnapshot } from './browser-session-cookie-restore'
import {
  admittedSessionCookieTracker,
  queueSnapshotWrite,
  retirementRemovedFile,
  type SessionCookieTracker
} from './browser-session-cookie-tracker'

/** Clears every cookie in a jar, durably; throws when the saved cookies may still restore them. */
export async function clearBrowserCookieJar(target: Session): Promise<void> {
  await admittedSessionCookieTracker(target)?.restored
  const { persisted } = await clearCookiesDurably(target, undefined, () =>
    withCookieMutationLock(target, () => target.clearStorageData({ storages: ['cookies'] }))
  )
  if (!persisted) {
    throw new Error('browser_cookie_clear_not_persisted')
  }
}

export async function clearBrowserCookieJarWithSource(
  partition: string,
  clearSource: () => boolean | Promise<boolean>
): Promise<boolean> {
  const target = session.fromPartition(partition)
  return withCookieImportSourceLock(target, async () => {
    if (!(await clearSource())) {
      return false
    }
    await clearBrowserCookieJar(target)
    return true
  })
}

/** For a clear already made in the live jar: see `clearCookiesDurably`. */
export async function persistBrowserCookieClear(
  target: Session,
  partial?: (cookie: CdpCookie) => boolean
): Promise<boolean> {
  return (await clearCookiesDurably(target, partial, async () => undefined)).persisted
}

/**
 * Runs a cookie clear so what it removed leaves Chromium's store and the saved session cookies now,
 * not at their next commit up to 30 s later, so a crash before then can't sign pages back in.
 * `partial` picks what a partial clear removes; a full clear omits it.
 *
 * The jar's tracker is admitted first, and `liveClear` runs in its write queue: a save, quit or
 * retirement that starts later is ordered after the whole clear, and the answer comes from that
 * tracker. A result `committable` rejects (the clear was revoked midway) isn't persisted.
 * `persisted` is false when the saved cookies may still hold what was cleared: a partial clear
 * can't edit a file this launch could not read (dropping it would sign every other site out), and
 * a retired jar's file may not be gone.
 */
export async function clearCookiesDurably<T>(
  target: Session,
  partial: ((cookie: CdpCookie) => boolean) | undefined,
  liveClear: () => Promise<T>,
  committable: (result: T) => boolean = () => true
): Promise<{ result: T; persisted: boolean }> {
  const tracker = admittedSessionCookieTracker(target)
  if (!tracker) {
    // Never tracked this launch: no saved file restores into this jar.
    const result = await liveClear()
    await target.cookies.flushStore()
    return { result, persisted: true }
  }
  const { result, persisted } = await queueSnapshotWrite(tracker, async () => {
    const result = await liveClear()
    return { result, persisted: committable(result) && (await commitClear(tracker, partial)) }
  })
  // Outside the queue: a retirement's removal is queued after this clear.
  return {
    result,
    persisted: persisted === 'retired' ? await retirementRemovedFile(tracker) : persisted
  }
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
    }
  }
  for (const [key, members] of tracker.unrestored) {
    const left = members.filter((cookie) => !cleared(cookie))
    if (left.length === 0) {
      tracker.unrestored.delete(key)
    } else {
      tracker.unrestored.set(key, left)
    }
  }
  // Changes went unrecorded while the file was unread: whether or not the removal lands, the
  // next save reads the whole jar.
  tracker.fullRead ||= tracker.savedFile === 'unread'
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
  scheduleSave(tracker)
  return true
}
