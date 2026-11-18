/**
 * Electron never writes session cookies (no expiry) to a partition's cookie database, so sites
 * that sign in with one sign out on every restart. Chrome keeps them when it restores the last
 * session, and Orca always restores its tabs, so Orca saves them itself and puts them back.
 */
import { app, session, type Cookie, type Session } from 'electron'
import { join } from 'node:path'
import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey, openCookieClearStore } from '../browser-cookie-clear-store'
import { mergeCdpCookiesIntoSession } from '../browser-partition-cookie-copy'
import { restoreUnpartitionedCookies } from './browser-session-cookie-unpartitioned-restore'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'
import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
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
  readSessionCookieSnapshot,
  removeSessionCookieSnapshot,
  writeSessionCookieSnapshot
} from './browser-session-cookie-snapshot-file'

import { usesMockKeychain } from '../../../startup/chromium-policy/configure-dev-keychain'

const SNAPSHOT_DIRECTORY = 'browser-session-cookies'
// Chromium commits its own cookie store this often.
const SAVE_DELAY_MS = 30_000
// Each CDP read or partitioned restore opens a hidden renderer; managed profiles are unbounded in number.
const HELPER_TARGET_CONCURRENCY = 2
const helperTargetSlots = new PrioritySemaphore(HELPER_TARGET_CONCURRENCY)

type SessionCookieTracker = {
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
  onChanged: (event: Electron.Event, cookie: Cookie, cause: string, removed: boolean) => void
}

let profileDirectory: string | null = null
let quitting = false
// Why keyed by file path: the same browser profile id ('default') exists in every Orca profile.
const trackers = new Map<string, SessionCookieTracker>()

export function configureBrowserSessionCookieSnapshots(directory: string): void {
  profileDirectory = directory
}

function snapshotPath(profileId: string, mockKeychain = usesMockKeychain()): string {
  return join(
    profileDirectory ?? app.getPath('userData'),
    mockKeychain ? `${SNAPSHOT_DIRECTORY}-mock-keychain` : SNAPSHOT_DIRECTORY,
    `${encodeURIComponent(profileId)}.json`
  )
}

/** Puts back each profile's saved session cookies; tracking starts first so no change is missed. */
export async function restoreBrowserSessionCookies(
  profiles: readonly BrowserSessionProfile[]
): Promise<void> {
  const restores = await Promise.all(
    profiles.map(async (profile) => {
      const filePath = snapshotPath(profile.id)
      const target = session.fromPartition(profile.partition)
      // Why before the read: a restored tab's cookie change during a slow read must still be seen.
      const tracker = track(filePath, target)
      tracker.reading = true
      const snapshot = await readSessionCookieSnapshot(filePath)
      const saved = snapshot ?? []
      tracker.saved = groupByScope(saved, cdpCookieScopeKey)
      tracker.savedStale = snapshot === null
      tracker.reading = false
      if (tracker.changedScopes.size > 0) {
        scheduleSave(tracker)
      }
      return { profile, target, saved, tracker }
    })
  )
  const leftovers = await Promise.all(
    restores
      .filter(({ saved }) => saved.length > 0)
      .map(async (restore) => {
        try {
          return {
            ...restore,
            saved: await restoreUnpartitionedCookies(restore.target, restore.saved)
          }
        } catch (error) {
          console.warn(
            '[browser-session-cookies] Restore failed for profile',
            restore.profile.id,
            error
          )
          return restore
        }
      })
  )
  await mapWithConcurrency(
    leftovers.filter(({ saved }) => saved.length > 0),
    HELPER_TARGET_CONCURRENCY,
    async ({ profile, target, saved, tracker }) => {
      let allWritten = false
      try {
        allWritten =
          (await mergeCdpCookiesIntoSession(saved, target, { sameJar: true })).copied ===
          saved.length
      } catch (error) {
        console.warn('[browser-session-cookies] Restore failed for profile', profile.id, error)
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
    }
  )
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
    savedStale: false,
    reading: false,
    changedScopes: new Map(),
    changedDuringSave: null,
    timer: null,
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

function scheduleSave(tracker: SessionCookieTracker): void {
  if (!tracker.timer && !tracker.changedDuringSave && !tracker.reading) {
    tracker.timer = setTimeout(() => void saveSessionCookies(tracker), SAVE_DELAY_MS)
  }
}

function cancelPendingSave(tracker: SessionCookieTracker): void {
  if (tracker.timer) {
    clearTimeout(tracker.timer)
    tracker.timer = null
  }
}

async function saveSessionCookies(tracker: SessionCookieTracker): Promise<void> {
  tracker.timer = null
  const changedDuringSave = new Map<string, ScopeChange>()
  tracker.changedDuringSave = changedDuringSave
  try {
    const cookies = await readSessionCookies(tracker)
    // After quit or deletion the file belongs to the quit prune or is gone.
    if (cookies && !quitting && trackers.get(tracker.filePath) === tracker) {
      const saved = groupByScope(cookies, cdpCookieScopeKey)
      // Sites often re-set a session cookie to the value it already had; skip the sealed write.
      if (tracker.savedStale || !sameSavedCookies(tracker.saved, saved)) {
        await writeSessionCookieSnapshot(tracker.filePath, cookies)
        // Only after the write: a failed one must leave the next save something to write.
        tracker.saved = saved
        tracker.savedStale = false
      }
      tracker.changedScopes = changedDuringSave
    }
  } catch (error) {
    console.warn('[browser-session-cookies] Save failed:', error)
  } finally {
    tracker.changedDuringSave = null
  }
  // A deleted profile's or a quitting app's leftover changes must not reopen a CDP target every 30 s.
  if (tracker.changedScopes.size > 0 && !quitting && trackers.get(tracker.filePath) === tracker) {
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
  const release = await helperTargetSlots.acquire(0)
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
      // A file still being read is left as it is, not replaced with what this launch saw.
      if (tracker.changedScopes.size === 0 || tracker.reading) {
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

export async function clearBrowserSessionCookieSnapshots(profileId: string): Promise<void> {
  const paths = [snapshotPath(profileId, false), snapshotPath(profileId, true)]
  for (const path of paths) {
    const tracker = trackers.get(path)
    if (tracker) {
      cancelPendingSave(tracker)
      tracker.target.cookies.off('changed', tracker.onChanged)
      trackers.delete(path)
      track(path, tracker.target)
    }
  }
  await Promise.all(paths.map(removeSessionCookieSnapshot))
}

/** For a browser profile being deleted. */
export function forgetBrowserSessionCookies(profileId: string): void {
  const warn = (error: unknown) =>
    console.warn(
      '[browser-session-cookies] Could not delete saved cookies for profile',
      profileId,
      error
    )
  try {
    for (const mockKeychain of [false, true]) {
      const filePath = snapshotPath(profileId, mockKeychain)
      const tracker = trackers.get(filePath)
      if (tracker) {
        cancelPendingSave(tracker)
        tracker.target.cookies.off('changed', tracker.onChanged)
        trackers.delete(filePath)
      }
      void removeSessionCookieSnapshot(filePath).catch(warn)
    }
  } catch (error) {
    warn(error)
  }
}
