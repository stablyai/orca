import { getChromeExtensionOrigin } from '../../../../shared/browser/extensions/browser-extension-url'
import { getBrowserExtensionDnrStore } from '../declarative-net-request/session/browser-extension-dnr-store'
import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import type { BrowserExtensionLoadKind } from './browser-extension-runtime-lifecycle'

/**
 * An idle unload only stops extensions to save memory, so what they set for the session (request
 * rules, action badge and icon, side panel options, non-persistent content scripts) waits for the
 * reattach. Profile → extension id → install time of the copy whose state is kept.
 */
const keptByProfileId = new Map<string, Map<string, number>>()
/** Kept state the reattach settled, until the extension's load claims it or the attach finishes. */
const awaitingByProfileId = new Map<string, Map<string, number>>()
/** Profiles an idle unload stopped this run: their reattach resumes extensions, not a startup. */
const idleUnloadedProfileIds = new Set<string>()
/** Profile → extensions reloaded while it was idle; they get onInstalled(update) on reattach. */
const reloadedWhileIdle = new Map<string, Set<string>>()
/**
 * Profile → extensions whose session can't resume: they used chrome.storage.session (unloading
 * empties it), lost open native messaging connections or notifications, or had a call still being
 * handled when they unloaded.
 * They start clean, with onStartup, instead.
 */
const cleanStartNeeded = new Map<string, Set<string>>()
const dropListeners = new Set<(profileId: string, extensionId: string) => void>()

function installTime(extensionId: string): number | undefined {
  return getBrowserExtensionInstallStore().get(extensionId)?.installTime
}

function addTo(map: Map<string, Set<string>>, profileId: string, extensionId: string): void {
  map.set(profileId, (map.get(profileId) ?? new Set<string>()).add(extensionId))
}

/** The extension's next reattach in this profile starts it clean (see `cleanStartNeeded`). */
export function noteBrowserExtensionNeedsCleanStart(profileId: string, extensionId: string): void {
  addTo(cleanStartNeeded, profileId, extensionId)
  // Why: found during an idle unload; reopening would drop this state, so don't hold it meanwhile.
  if (isBrowserExtensionStateKeptWhileIdle(profileId, extensionId)) {
    dropKept(keptByProfileId, profileId, extensionId)
    forgetSessionRules(profileId, extensionId)
  }
}

function forgetSessionRules(profileId: string, extensionId: string): void {
  getBrowserExtensionDnrStore().writeSessionRules(profileId, { id: extensionId, version: '' }, [])
}

/** Each load starts afresh: empty session storage, no native connections. */
export function forgetBrowserExtensionCleanStartNeed(profileId: string, extensionId: string) {
  cleanStartNeeded.get(profileId)?.delete(extensionId)
}

/**
 * Offscreen documents write storage without Orca's relay, so their use can't be seen; an extension
 * that may open one is treated as a session storage user.
 */
function needsCleanStart(profileId: string, extensionId: string): boolean {
  const permissions = getBrowserExtensionInstallStore().get(extensionId)?.permissions ?? []
  return (
    cleanStartNeeded.get(profileId)?.has(extensionId) === true ||
    (permissions.includes('offscreen') && permissions.includes('storage'))
  )
}

/**
 * Called as an idle unload commits, with the copies running then; later loads start clean, as do
 * copies that already need a clean start, whose session rules go now.
 */
export function beginIdleUnload(profileId: string, sess: Electron.Session): void {
  idleUnloadedProfileIds.add(profileId)
  // Why Electron's list: Orca's own worker handles can miss a stop and look running.
  const runningScopes = new Set(
    Object.values(sess.serviceWorkers.getAllRunning()).map((worker) => worker.scope)
  )
  const kept = new Map<string, number>()
  for (const { id } of sess.extensions.getAllExtensions()) {
    // Why: a worker still up a minute after the last tab closed is held open by something the
    // stop ends (a native port, a session write not yet reported), so only onStartup restores it.
    if (runningScopes.has(`${getChromeExtensionOrigin(id)}/`)) {
      noteBrowserExtensionNeedsCleanStart(profileId, id)
    }
    const time = installTime(id)
    if (time !== undefined && !needsCleanStart(profileId, id)) {
      kept.set(id, time)
    } else {
      forgetSessionRules(profileId, id)
    }
  }
  if (kept.size > 0) {
    keptByProfileId.set(profileId, kept)
  }
}

/** A resumed extension's load has not claimed its kept state yet. */
export function isBrowserExtensionResuming(profileId: string, extensionId: string): boolean {
  return awaitingByProfileId.get(profileId)?.has(extensionId) === true
}

/** Unload listeners skip forgetting the session state of an extension kept here. */
export function isBrowserExtensionStateKeptWhileIdle(
  profileId: string,
  extensionId: string
): boolean {
  return keptByProfileId.get(profileId)?.has(extensionId) === true
}

/** Session-state owners forget an extension's state when its kept state is dropped. */
export function onBrowserExtensionIdleStateDropped(
  listener: (profileId: string, extensionId: string) => void
): void {
  dropListeners.add(listener)
}

/**
 * Before an attach loads anything. An extension resumes, with its kept state and no lifecycle
 * event, only if the same copy ran when the profile went idle and nothing it held was lost (see
 * `cleanStartNeeded`). Any other starts clean: kept state and session rules go, and onStartup
 * fires, so it is never left with partial state and no signal. One reloaded while idle gets
 * onInstalled(update) instead.
 */
export function settleKeptStateOnAttach(
  profileId: string,
  enabledExtensionIds: readonly string[]
): (extensionId: string) => BrowserExtensionLoadKind {
  const enabled = new Set(enabledExtensionIds)
  dropKept(
    keptByProfileId,
    profileId,
    (id, time) => !enabled.has(id) || installTime(id) !== time || needsCleanStart(profileId, id)
  )
  const resumed = keptByProfileId.get(profileId) ?? new Map<string, number>()
  keptByProfileId.delete(profileId)
  if (resumed.size > 0) {
    awaitingByProfileId.set(profileId, resumed)
  }
  const reloaded = reloadedWhileIdle.get(profileId) ?? new Set<string>()
  reloadedWhileIdle.delete(profileId)
  const kindFor = (id: string): BrowserExtensionLoadKind =>
    reloaded.has(id) ? 'reload' : resumed.has(id) ? 'other' : 'startup'
  for (const id of enabled) {
    if (kindFor(id) === 'startup') {
      forgetSessionRules(profileId, id)
    }
  }
  return kindFor
}

/** The reattach loaded the kept copy: its state is live again. */
export function claimBrowserExtensionIdleState(profileId: string, extensionId: string): void {
  const awaiting = awaitingByProfileId.get(profileId)
  awaiting?.delete(extensionId)
  if (awaiting?.size === 0) {
    awaitingByProfileId.delete(profileId)
  }
}

/**
 * The reattach's loads settled: what none claimed failed, was disabled or reloaded meanwhile. It
 * isn't loaded when the profile next goes idle, so its next reattach starts it clean.
 */
export function dropUnclaimedBrowserExtensionIdleState(profileId: string): void {
  dropKept(awaitingByProfileId, profileId, () => true)
}

/** Settings reloaded the extension where it runs; profiles stopped or stopping get it on reattach. */
export function noteBrowserExtensionReloadedWhileIdle(
  extensionId: string,
  detachedProfileIds: readonly string[]
): void {
  dropBrowserExtensionIdleState({ extensionId })
  for (const profileId of detachedProfileIds) {
    noteBrowserExtensionReloadPendingInIdleProfile(profileId, extensionId)
  }
}

/** A reload's load was skipped or cancelled because the profile went idle meanwhile. */
export function noteBrowserExtensionReloadPendingInIdleProfile(
  profileId: string,
  extensionId: string
): void {
  if (idleUnloadedProfileIds.has(profileId)) {
    addTo(reloadedWhileIdle, profileId, extensionId)
  }
}

/**
 * Drops kept state: the extension was reloaded or uninstalled, or the profile deleted.
 * `forgetProfile` (profile delete) and an empty scope (extensions turned off, like a browser quit)
 * also forget that the profile went idle.
 */
export function dropBrowserExtensionIdleState(scope: {
  profileId?: string
  extensionId?: string
  forgetProfile?: boolean
}): void {
  const { profileId, extensionId } = scope
  if (profileId === undefined && extensionId === undefined) {
    idleUnloadedProfileIds.clear()
    reloadedWhileIdle.clear()
    cleanStartNeeded.clear()
  } else if (profileId !== undefined && scope.forgetProfile) {
    idleUnloadedProfileIds.delete(profileId)
    reloadedWhileIdle.delete(profileId)
    cleanStartNeeded.delete(profileId)
  } else if (extensionId !== undefined && profileId === undefined) {
    // Reload or uninstall: what the old copy left per profile goes with it.
    for (const byProfile of [reloadedWhileIdle, cleanStartNeeded]) {
      for (const ids of byProfile.values()) {
        ids.delete(extensionId)
      }
    }
  }
  for (const map of [keptByProfileId, awaitingByProfileId]) {
    for (const id of profileId === undefined ? [...map.keys()] : [profileId]) {
      dropKept(map, id, extensionId === undefined ? () => true : extensionId)
    }
  }
}

/** `matches` is one extension id (a keyed lookup) or a test over every kept extension. */
function dropKept(
  map: Map<string, Map<string, number>>,
  profileId: string,
  matches: string | ((extensionId: string, time: number) => boolean)
): void {
  const kept = map.get(profileId)
  const ids =
    typeof matches === 'string'
      ? kept?.has(matches)
        ? [matches]
        : []
      : [...(kept ?? [])].filter(([id, time]) => matches(id, time)).map(([id]) => id)
  for (const extensionId of ids) {
    kept?.delete(extensionId)
    for (const listener of dropListeners) {
      listener(profileId, extensionId)
    }
  }
  if (kept?.size === 0) {
    map.delete(profileId)
  }
}
