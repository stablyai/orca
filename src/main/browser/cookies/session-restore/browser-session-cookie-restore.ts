/**
 * Electron never writes session cookies (no expiry) to a partition's cookie database, so sites
 * that sign in with one sign out on every restart. Chrome keeps them when it restores the last
 * session, and Orca always restores its tabs, so Orca saves them itself and puts them back.
 */
import { app, session, type Cookie, type Session } from 'electron'
import { join } from 'node:path'
import type { BrowserSessionProfile } from '../../../../shared/browser-workspace-types'
import type { CdpCookie } from '../browser-cdp-cookie'
import {
  cdpCookieScopeKey,
  cookieScopeKey,
  openCookieClearStore
} from '../browser-cookie-clear-store'
import { mergeCdpCookiesIntoSession } from '../browser-partition-cookie-copy'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import {
  readSessionCookieSnapshot,
  removeSessionCookieSnapshot,
  writeSessionCookieSnapshot
} from './browser-session-cookie-snapshot-file'

const SNAPSHOT_DIRECTORY = 'browser-session-cookies'
// Chromium commits its own cookie store this often; each save opens a hidden CDP target.
const SAVE_DELAY_MS = 30_000
const RESTORE_CONCURRENCY = 2

type SessionCookieTracker = {
  target: Session
  filePath: string
  /** What the file holds now, by scope. */
  saved: Map<string, CdpCookie[]>
  /** Scopes whose cookies changed since `saved` was read. */
  changedScopes: Set<string>
  /** Set while a save reads: scopes that changed meanwhile, which the read may have missed. */
  changedDuringSave: Set<string> | null
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

function snapshotPath(profileId: string): string {
  return join(
    profileDirectory ?? app.getPath('userData'),
    SNAPSHOT_DIRECTORY,
    `${encodeURIComponent(profileId)}.json`
  )
}

function liveCookieScopeKey(cookie: Cookie): string | null {
  return cookieScopeKey(
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.hostOnly ?? !cookie.domain?.startsWith('.')
  )
}

function groupByScope<T>(
  cookies: readonly T[],
  scopeKey: (cookie: T) => string | null
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const cookie of cookies) {
    const key = scopeKey(cookie)
    if (!key) {
      continue
    }
    const group = groups.get(key)
    if (group) {
      group.push(cookie)
    } else {
      groups.set(key, [cookie])
    }
  }
  return groups
}

/** Puts back each profile's saved session cookies; tracking starts first so no change is missed. */
export async function restoreBrowserSessionCookies(
  profiles: readonly BrowserSessionProfile[]
): Promise<void> {
  const restores = await Promise.all(
    profiles.map(async (profile) => {
      const filePath = snapshotPath(profile.id)
      const target = session.fromPartition(profile.partition)
      const saved = await readSessionCookieSnapshot(filePath)
      track(filePath, target, saved)
      return { profile, target, saved }
    })
  )
  // Each restore opens a hidden CDP target; managed profiles are unbounded in number.
  const pending = restores.filter(({ saved }) => saved.length > 0)
  await mapWithConcurrency(pending, RESTORE_CONCURRENCY, async ({ profile, target, saved }) => {
    try {
      await mergeCdpCookiesIntoSession(saved, target, { sameJar: true })
    } catch (error) {
      console.warn('[browser-session-cookies] Restore failed for profile', profile.id, error)
    }
  })
}

/** For a profile created after launch: nothing to restore yet. */
export function trackBrowserSessionCookies(profile: BrowserSessionProfile): void {
  track(snapshotPath(profile.id), session.fromPartition(profile.partition), [])
}

function track(filePath: string, target: Session, saved: CdpCookie[]): void {
  if (trackers.has(filePath)) {
    return
  }
  const tracker: SessionCookieTracker = {
    target,
    filePath,
    saved: groupByScope(saved, cdpCookieScopeKey),
    changedScopes: new Set(),
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
      const savedInScope = tracker.saved.get(key) ?? []
      // Restoring writes back exactly what the file holds; that is not a change.
      const matchesSaved =
        !removed && cookie.session && savedInScope.some((saved) => saved.value === cookie.value)
      // A saved cookie replaced by an expiring one must leave the file too.
      if (matchesSaved || (!cookie.session && savedInScope.length === 0)) {
        return
      }
      tracker.changedScopes.add(key)
      tracker.changedDuringSave?.add(key)
      scheduleSave(tracker)
    }
  }
  trackers.set(filePath, tracker)
  target.cookies.on('changed', tracker.onChanged)
}

function scheduleSave(tracker: SessionCookieTracker): void {
  if (!tracker.timer && !tracker.changedDuringSave) {
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
  const changedDuringSave = new Set<string>()
  tracker.changedDuringSave = changedDuringSave
  try {
    const cookies = await withCookieMutationLock(tracker.target, async () => {
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
    // After quit or deletion the file belongs to the quit prune or is gone.
    if (cookies && !quitting && trackers.get(tracker.filePath) === tracker) {
      const saved = groupByScope(cookies, cdpCookieScopeKey)
      // Sites often re-set a session cookie to the value it already had; skip the sealed write.
      if (!sameSavedCookies(tracker.saved, saved)) {
        tracker.saved = saved
        await writeSessionCookieSnapshot(tracker.filePath, cookies)
      }
      tracker.changedScopes = changedDuringSave
    }
  } catch (error) {
    console.warn('[browser-session-cookies] Save failed:', error)
  } finally {
    tracker.changedDuringSave = null
  }
  if (tracker.changedScopes.size > 0) {
    scheduleSave(tracker)
  }
}

/**
 * Final save on quit, without a CDP target (not safe this late). Unchanged scopes keep what was
 * saved. A changed scope keeps its one unpartitioned cookie with the live value; anything else
 * there is dropped, so a sign-out sticks and a cookie is never restored into the wrong partition.
 */
export async function flushBrowserSessionCookiesOnQuit(): Promise<void> {
  quitting = true
  await Promise.all(
    [...trackers.values()].map(async (tracker) => {
      cancelPendingSave(tracker)
      if (tracker.changedScopes.size === 0) {
        return
      }
      try {
        const live = await tracker.target.cookies.get({ session: true })
        await writeSessionCookieSnapshot(
          tracker.filePath,
          savedCookiesAfterChanges(tracker.saved, tracker.changedScopes, live)
        )
      } catch (error) {
        console.warn('[browser-session-cookies] Final save failed:', error)
      }
    })
  )
}

function savedCookiesAfterChanges(
  saved: ReadonlyMap<string, CdpCookie[]>,
  changedScopes: ReadonlySet<string>,
  live: readonly Cookie[]
): CdpCookie[] {
  const liveByScope = groupByScope(live, liveCookieScopeKey)
  return [...saved].flatMap(([key, savedInScope]) => {
    if (!changedScopes.has(key)) {
      return savedInScope
    }
    // Electron's cookie list has no partition keys, so only a one-to-one match is certain.
    const liveInScope = liveByScope.get(key) ?? []
    const [cookie] = savedInScope
    return savedInScope.length === 1 && !cookie.partitionKey && liveInScope.length === 1
      ? [{ ...cookie, value: liveInScope[0].value }]
      : []
  })
}

function sameSavedCookies(
  a: ReadonlyMap<string, CdpCookie[]>,
  b: ReadonlyMap<string, CdpCookie[]>
): boolean {
  return (
    a.size === b.size &&
    [...a].every(([key, cookies]) => JSON.stringify(cookies) === JSON.stringify(b.get(key)))
  )
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
    const filePath = snapshotPath(profileId)
    const tracker = trackers.get(filePath)
    if (tracker) {
      cancelPendingSave(tracker)
      tracker.target.cookies.off('changed', tracker.onChanged)
      trackers.delete(filePath)
    }
    void removeSessionCookieSnapshot(filePath).catch(warn)
  } catch (error) {
    warn(error)
  }
}
