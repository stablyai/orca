/**
 * Electron never writes session cookies (no expiry) to a partition's cookie database, so sites
 * that sign in with one sign out on every restart. Chrome keeps them when it restores the last
 * session, and Orca always restores its tabs, so Orca saves them itself and puts them back.
 */
import { session, type Session } from 'electron'
import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey, openCookieClearStore } from '../browser-cookie-clear-store'
import {
  restoreLeftoverCookies,
  restoreUnpartitionedCookies
} from './browser-session-cookie-unpartitioned-restore'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'
import { PrioritySemaphore } from '../../../../shared/concurrency/priority-semaphore'
import {
  groupByScope,
  liveCookieScopeKey,
  noteScopeChange,
  sameSavedCookies,
  savedCookiesAfterChanges,
  forgetObservedUnrestored,
  withUnrestoredCookies,
  type ScopeChange
} from './browser-session-cookie-scopes'
import {
  canSealSessionCookies,
  readSessionCookieSnapshot,
  snapshotPath,
  writeSessionCookieSnapshot
} from './browser-session-cookie-snapshot-file'
import {
  cancelPendingSave,
  pendingSnapshotRemoval,
  pendingSnapshotRemovals,
  queueSnapshotWrite,
  releaseRetiredTracker,
  sessionCookieTrackers as trackers,
  type SessionCookieTracker
} from './browser-session-cookie-tracker'

// Chromium commits its own cookie store this often.
const SAVE_DELAY_MS = 30_000
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
      // A retirement still removing the file finishes first, so this reads nothing it removed.
      await pendingSnapshotRemoval(snapshotTarget.filePath)
      const snapshot = await readSessionCookieSnapshot(snapshotTarget.filePath)
      const saved = snapshot ?? []
      tracker.saved = groupByScope(saved, cdpCookieScopeKey)
      tracker.savedFile = snapshot === null ? 'unread' : 'same'
      if (snapshot === null) {
        // Nothing is saved over it this launch, so changes seen so far have nowhere to go.
        tracker.changedScopes.clear()
        console.warn(
          '[browser-session-cookies] Could not read saved cookies for',
          snapshotTarget.label,
          '- keeping the file; a full cookie clear resets it'
        )
      }
      return { label: snapshotTarget.label, target, saved, tracker }
    })
  )
  // A route partition cleared while its restore ran must not get its cookies back.
  const current = (tracker: SessionCookieTracker): boolean =>
    trackers.get(tracker.filePath) === tracker
  try {
    await Promise.all(
      restores
        .filter(({ saved, tracker }) => saved.length > 0 && current(tracker))
        .map(async ({ label, target, saved, tracker }) => {
          let leftovers = saved
          try {
            leftovers = await restoreUnpartitionedCookies(target, saved)
          } catch (error) {
            console.warn('[browser-session-cookies] Restore failed for', label, error)
          }
          if (leftovers.length === 0) {
            return
          }
          // Shared with saves, so route partitions opening at once can't multiply hidden helpers.
          const release = await helperTargetSlots.acquire(RESTORE_PRIORITY)
          try {
            // Kept as saved: a live read can't show them, and dropping them would sign those sites out.
            const missing = current(tracker)
              ? await restoreLeftoverCookies(target, leftovers, label)
              : []
            for (const cookie of missing) {
              const key = cdpCookieScopeKey(cookie)
              if (key) {
                tracker.unrestored.set(key, [...(tracker.unrestored.get(key) ?? []), cookie])
              }
            }
          } finally {
            release()
          }
        })
    )
  } finally {
    // Only now may a save or quit compare against the file: before, the jar was still filling.
    for (const { tracker } of restores) {
      tracker.reading = false
      if (tracker.changedScopes.size > 0) {
        scheduleSave(tracker)
      }
    }
  }
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
    rewriteRetried: false,
    reading: false,
    unrestored: new Map(),
    fullRead: false,
    changedScopes: new Map(),
    changedDuringSave: null,
    timer: null,
    // Writes start after a retirement still removing the file.
    saving: pendingSnapshotRemoval(filePath) ?? null,
    retired: null,
    restored: null,
    onChanged: (_event, cookie, cause, removed) => {
      // The insert that follows an overwrite says whether the value really changed.
      // An unread file takes no saves, so its changes would only pile up.
      if (
        quitting ||
        tracker.savedFile === 'unread' ||
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
      // In a scope launch couldn't restore, the jar may hold another cookie: only CDP can tell.
      const unrestored = tracker.unrestored.has(key)
      const change: ScopeChange = unrestored || removed || !cookie.session ? 'other' : 'value'
      noteScopeChange(tracker.changedScopes, key, change)
      if (tracker.changedDuringSave) {
        noteScopeChange(tracker.changedDuringSave, key, change)
      }
      scheduleSave(tracker)
    }
  }
  trackers.set(filePath, tracker)
  releaseRetiredTracker(filePath)
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
  if (tracker.savedFile === 'unread') {
    return
  }
  // A failed clear's rewrite gets this one retry; after it, only a real change is written.
  const rewrite = tracker.savedFile === 'stale' && !tracker.rewriteRetried
  tracker.rewriteRetried ||= rewrite
  // A failed clear that kept nothing removes the file first: neither sealing nor a read of the
  // jar (which may fail) can hold that up. Capturing newer cookies is a separate step.
  const current = !quitting && trackers.get(tracker.filePath) === tracker
  let forced = rewrite
  if (rewrite && tracker.saved.size === 0 && current) {
    // This is its one removal attempt. If it fails, a newer cookie read below may still replace
    // the file (a sealed write replaces it whole); an empty read leaves it to quit.
    forced = false
    await writeTrackedSnapshot(tracker, []).catch((error: unknown) =>
      console.warn('[browser-session-cookies] Save failed:', error)
    )
  }
  // Quit or a retirement may have started during that removal: neither may wait on the lock below.
  if (quitting || trackers.get(tracker.filePath) !== tracker || !canSealSessionCookies()) {
    return
  }
  const changedDuringSave = new Map<string, ScopeChange>()
  tracker.changedDuringSave = changedDuringSave
  try {
    const read = await readSessionCookies(tracker)
    const cookies = read && withUnrestoredCookies(read, tracker.unrestored)
    // After quit or deletion the file belongs to the quit prune or is gone.
    if (cookies && !quitting && trackers.get(tracker.filePath) === tracker) {
      const saved = groupByScope(cookies, cdpCookieScopeKey)
      // Sites often re-set a session cookie to the value it already had; skip the sealed write.
      if ((forced && tracker.savedFile === 'stale') || !sameSavedCookies(tracker.saved, saved)) {
        await writeTrackedSnapshot(tracker, cookies)
      }
      tracker.fullRead = false
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
  // A rewrite that failed again waits for a newer change or quit, not another timer; a change
  // seen during this save gets its own.
  const pending =
    tracker.savedFile === 'stale' ? changedDuringSave.size > 0 : tracker.changedScopes.size > 0
  if (pending) {
    scheduleSave(tracker)
  }
}

/** Sites that rotate a session cookie's value need no CDP read; anything else does, a few at a time. */
async function readSessionCookies(tracker: SessionCookieTracker): Promise<CdpCookie[] | null> {
  const updated = await withCookieMutationLock(tracker.target, async () =>
    // Quit or a retirement may have started meanwhile (a failed removal, the lock): its write
    // must not queue behind this read.
    quitting || trackers.get(tracker.filePath) !== tracker
      ? null
      : savedCookiesAfterChanges(
          tracker.saved,
          tracker.changedScopes,
          await tracker.target.cookies.get({ session: true })
        )
  )
  // After a clear of a file this launch couldn't read, changes went unrecorded: read it all.
  if (!updated || (updated.certain && !tracker.fullRead)) {
    return updated?.cookies ?? null
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
        const live = await store.readAllCdpCookies()
        // Before filtering: a persistent cookie that replaced an unrestored one settles it too.
        forgetObservedUnrestored(tracker.unrestored, live)
        return live.filter((cookie) => cookie.session === true)
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
  // A retirement already removing a file lands first; nothing writes a retired file after it.
  await Promise.all(pendingSnapshotRemovals())
  await Promise.all(
    [...trackers.values()].map(async (tracker) => {
      cancelPendingSave(tracker)
      // Queued, so it lands after any clear or save already writing and before any after it.
      await queueSnapshotWrite(tracker, async () => {
        // A file still being read, or that could not be read, is left as it is: this keeps only
        // saved scopes, so it would replace that file with nothing. A failed clear gets a last try.
        const unchanged = tracker.changedScopes.size === 0 && tracker.savedFile === 'same'
        if (unchanged || tracker.reading || tracker.savedFile === 'unread') {
          return
        }
        // Nothing saved means nothing to keep: a failed clear's removal needs no live read.
        const live =
          tracker.saved.size === 0 ? [] : await tracker.target.cookies.get({ session: true })
        const cookies = withUnrestoredCookies(
          savedCookiesAfterChanges(tracker.saved, tracker.changedScopes, live).cookies,
          tracker.unrestored,
          live
        )
        // Checked after the read: a jar retired meanwhile has its file gone or going.
        const current = trackers.get(tracker.filePath) === tracker
        if (current && (cookies.length === 0 || canSealSessionCookies())) {
          // Tracked, so a clear queued after quit edits what quit wrote, not what it replaced.
          await writeTrackedSnapshot(tracker, cookies)
        }
      }).catch((error: unknown) =>
        console.warn('[browser-session-cookies] Final save failed:', error)
      )
    })
  )
}
