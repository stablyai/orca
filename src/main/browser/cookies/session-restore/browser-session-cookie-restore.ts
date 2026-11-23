/**
 * Electron never writes session cookies (no expiry) to a partition's cookie database, so sites
 * that sign in with one sign out on every restart. Chrome keeps them when it restores the last
 * session, and Orca always restores its tabs, so Orca saves them itself and puts them back.
 */
import { session, type Session } from 'electron'
import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey, openCookieClearStore } from '../browser-cookie-clear-store'
import { mergeCdpCookiesIntoSession } from '../browser-partition-cookie-copy'
import { restoreUnpartitionedCookies } from './browser-session-cookie-unpartitioned-restore'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'
import { PrioritySemaphore } from '../../../../shared/concurrency/priority-semaphore'
import {
  groupByScope,
  liveCookieScopeKey,
  noteScopeChange,
  sameSavedCookies,
  savedCookiesAfterChanges,
  type ScopeChange
} from './browser-session-cookie-scopes'
import {
  canSealSessionCookies,
  readSessionCookieSnapshot,
  removeSessionCookieSnapshot,
  snapshotPath,
  writeSessionCookieSnapshot
} from './browser-session-cookie-snapshot-file'
import {
  cancelPendingSave,
  queueSnapshotWrite,
  sessionCookieTrackers as trackers,
  stopTrackingSessionCookies,
  type SessionCookieTracker
} from './browser-session-cookie-tracker'

// Chromium commits its own cookie store this often.
const SAVE_DELAY_MS = 30_000
const CLEAR_REWRITE_ATTEMPTS = 3
// Each CDP read or partitioned restore opens a hidden renderer; managed profiles are unbounded in number.
const HELPER_TARGET_CONCURRENCY = 2
const helperTargetSlots = new PrioritySemaphore(HELPER_TARGET_CONCURRENCY)
// Lower runs first: a restore holds a page's first load, a save does not.
const RESTORE_PRIORITY = 0
const SAVE_PRIORITY = 1

let quitting = false

type SnapshotTarget = { label: string; filePath: string; partition: string }

/** Puts back each profile's saved session cookies; tracking starts first so no change is missed. */
export async function restoreBrowserSessionCookies(
  profiles: readonly BrowserSessionProfile[]
): Promise<void> {
  const targets = profiles.map((profile) => ({
    label: profile.id,
    filePath: snapshotPath(profile.id),
    partition: profile.partition
  }))
  const restore = restoreSnapshotTargets(targets)
  const restored = restore.catch(() => {})
  for (const { filePath } of targets) {
    const tracker = trackers.get(filePath)
    if (tracker) {
      tracker.restored = restored
    }
  }
  await restore
}

export async function restoreSnapshotTargets(targets: readonly SnapshotTarget[]): Promise<void> {
  const restores = await Promise.all(
    targets.map(async (snapshotTarget) => {
      const target = session.fromPartition(snapshotTarget.partition)
      // Why before the read: a restored tab's cookie change during a slow read must still be seen.
      const tracker = track(snapshotTarget.filePath, target)
      tracker.reading = true
      const snapshot = await readSessionCookieSnapshot(snapshotTarget.filePath)
      const saved = snapshot ?? []
      tracker.saved = groupByScope(saved, cdpCookieScopeKey)
      tracker.savedFile = snapshot === null ? 'unread' : 'same'
      tracker.reading = false
      if (tracker.changedScopes.size > 0) {
        scheduleSave(tracker)
      }
      return { label: snapshotTarget.label, target, saved, tracker }
    })
  )
  // A route partition cleared while its restore ran must not get its cookies back.
  const current = (tracker: SessionCookieTracker): boolean =>
    trackers.get(tracker.filePath) === tracker
  const leftovers = await Promise.all(
    restores
      .filter(({ saved, tracker }) => saved.length > 0 && current(tracker))
      .map(async (restore) => {
        try {
          return {
            ...restore,
            saved: await restoreUnpartitionedCookies(restore.target, restore.saved)
          }
        } catch (error) {
          console.warn('[browser-session-cookies] Restore failed for', restore.label, error)
          return restore
        }
      })
  )
  await Promise.all(
    leftovers.map(async ({ label, target, saved, tracker }) => {
      if (saved.length === 0) {
        return
      }
      // Shared with saves, so route partitions opening at once can't multiply hidden helpers.
      const release = await helperTargetSlots.acquire(RESTORE_PRIORITY)
      let allWritten = false
      try {
        if (!current(tracker)) {
          return
        }
        allWritten =
          (await mergeCdpCookiesIntoSession(saved, target, { sameJar: true })).copied ===
          saved.length
      } catch (error) {
        console.warn('[browser-session-cookies] Restore failed for', label, error)
      } finally {
        release()
      }
      if (allWritten) {
        return
      }
      // The jar may hold another cookie there, so only a CDP read can tell what a later change is.
      for (const cookie of saved) {
        const key = cdpCookieScopeKey(cookie)
        if (key) {
          noteScopeChange(tracker.changedScopes, key, 'other')
        }
      }
    })
  )
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

/** For a profile created after launch: nothing to restore yet. */
export function trackBrowserSessionCookies(profile: BrowserSessionProfile): void {
  track(snapshotPath(profile.id), session.fromPartition(profile.partition))
}

function track(filePath: string, target: Session): SessionCookieTracker {
  const existing = trackers.get(filePath)
  if (existing) {
    return existing
  }
  const tracker: SessionCookieTracker = {
    target,
    filePath,
    saved: new Map(),
    savedFile: 'same',
    rewriteAttempts: 0,
    reading: false,
    changedScopes: new Map(),
    changedDuringSave: null,
    timer: null,
    saving: null,
    restored: null,
    onChanged: (_event, cookie, cause, removed) => {
      // The insert that follows an overwrite says whether the value really changed.
      if (
        quitting ||
        (!cookie.session && tracker.saved.size === 0) ||
        cause === 'inserted-no-change-overwrite' ||
        (removed && cause === 'overwrite')
      ) {
        return
      }
      const key = liveCookieScopeKey(cookie)
      if (!key) {
        return
      }
      // A saved cookie replaced by an expiring one must leave the file too.
      if (!cookie.session && !tracker.saved.has(key)) {
        return
      }
      // Even an insert matching the file counts: it may be a partitioned twin, which this event can't
      // show. A removal or an expiring cookie can hide a partition change, so only CDP can tell.
      const change: ScopeChange = removed || !cookie.session ? 'other' : 'value'
      noteScopeChange(tracker.changedScopes, key, change)
      if (tracker.changedDuringSave) {
        noteScopeChange(tracker.changedDuringSave, key, change)
      }
      scheduleSave(tracker)
    }
  }
  trackers.set(filePath, tracker)
  target.cookies.on('changed', tracker.onChanged)
  return tracker
}

export function scheduleSave(tracker: SessionCookieTracker): void {
  // An unread file is left as it is, so nothing would be saved over it.
  const fenced = tracker.reading || tracker.savedFile === 'unread'
  if (!tracker.timer && !tracker.changedDuringSave && !fenced) {
    tracker.timer = setTimeout(
      () => void queueSnapshotWrite(tracker, () => saveSessionCookies(tracker)),
      SAVE_DELAY_MS
    )
  }
}

async function saveSessionCookies(tracker: SessionCookieTracker): Promise<void> {
  tracker.timer = null
  // Live cookies can't be stored unsealed (a failed clear's rewrite may still remove the file).
  if (
    tracker.savedFile === 'unread' ||
    (tracker.savedFile === 'same' && !canSealSessionCookies())
  ) {
    return
  }
  const changedDuringSave = new Map<string, ScopeChange>()
  tracker.changedDuringSave = changedDuringSave
  try {
    const cookies = await readSessionCookies(tracker)
    // After quit or deletion the file belongs to the quit prune or is gone.
    if (cookies && !quitting && trackers.get(tracker.filePath) === tracker) {
      const saved = groupByScope(cookies, cdpCookieScopeKey)
      // Sites often re-set a session cookie to the value it already had; skip the sealed write.
      if (tracker.savedFile === 'stale' || !sameSavedCookies(tracker.saved, saved)) {
        await writeTrackedSnapshot(tracker, cookies)
      }
      tracker.changedScopes = changedDuringSave
    }
  } catch (error) {
    console.warn('[browser-session-cookies] Save failed:', error)
  } finally {
    tracker.changedDuringSave = null
  }
  // A deleted profile's or a quitting app's leftover changes must not reopen a CDP target every 30 s.
  if (quitting || trackers.get(tracker.filePath) !== tracker) {
    return
  }
  // A failed clear's rewrite is retried a few times even with nothing else changed, then left to
  // the next cookie change or quit.
  const retry =
    tracker.savedFile === 'stale'
      ? ++tracker.rewriteAttempts < CLEAR_REWRITE_ATTEMPTS
      : tracker.changedScopes.size > 0
  if (retry) {
    scheduleSave(tracker)
  }
}

/** Sites that rotate a session cookie's value need no CDP read; anything else does, a few at a time. */
async function readSessionCookies(tracker: SessionCookieTracker): Promise<CdpCookie[] | null> {
  const updated = await withCookieMutationLock(tracker.target, async () =>
    savedCookiesAfterChanges(
      tracker.saved,
      tracker.changedScopes,
      await tracker.target.cookies.get({ session: true })
    )
  )
  if (updated.certain) {
    return updated.cookies
  }
  // Why the slot before the lock: a queued save must not hold its profile's imports and clears.
  const release = await helperTargetSlots.acquire(SAVE_PRIORITY)
  try {
    return await withCookieMutationLock(tracker.target, async () => {
      // A save still queued behind an import when quit starts must not open a CDP target.
      if (quitting) {
        return null
      }
      const store = openCookieClearStore(tracker.target)
      try {
        return (await store.readAllCdpCookies()).filter((cookie) => cookie.session === true)
      } finally {
        store.dispose()
      }
    })
  } finally {
    release()
  }
}

/**
 * Final save on quit, without a CDP target (not safe this late). Unchanged scopes keep what was
 * saved. A changed scope keeps its one cookie with the live value when only that cookie was set
 * again; anything else there is dropped, so a sign-out sticks and a cookie is never restored
 * into the wrong partition.
 */
export async function flushBrowserSessionCookiesOnQuit(): Promise<void> {
  quitting = true
  await Promise.all(
    [...trackers.values()].map(async (tracker) => {
      cancelPendingSave(tracker)
      // After any clear or save already writing, so this one lands last.
      await tracker.saving
      // A file still being read, or that could not be read, is left as it is: this keeps only
      // saved scopes, so it would replace that file with nothing. A failed clear gets a last try.
      const unchanged = tracker.changedScopes.size === 0 && tracker.savedFile === 'same'
      if (unchanged || tracker.reading || tracker.savedFile === 'unread') {
        return
      }
      try {
        const live = await tracker.target.cookies.get({ session: true })
        await writeSessionCookieSnapshot(
          tracker.filePath,
          savedCookiesAfterChanges(tracker.saved, tracker.changedScopes, live).cookies
        )
      } catch (error) {
        console.warn('[browser-session-cookies] Final save failed:', error)
      }
    })
  )
}

/** For a browser profile being deleted. */
export function forgetBrowserSessionCookies(profileId: string): void {
  try {
    const filePath = snapshotPath(profileId)
    stopTrackingSessionCookies(filePath)
    void removeSessionCookieSnapshot(filePath).catch((error: unknown) =>
      warnForgetFailed(profileId, error)
    )
  } catch (error) {
    warnForgetFailed(profileId, error)
  }
}

function warnForgetFailed(label: string, error: unknown): void {
  console.warn('[browser-session-cookies] Could not delete saved cookies for', label, error)
}
