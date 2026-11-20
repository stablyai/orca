import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import type { BrowserExtensionLoadKind } from './browser-extension-runtime-lifecycle'

/**
 * An idle unload only stops extensions to save memory, so what they set for the session (action
 * badge and icon, side panel options, non-persistent content scripts) waits for the reattach.
 * Profile → extension id → install time of the copy whose state is kept, until a load claims it.
 */
const keptByProfileId = new Map<string, Map<string, number>>()
/** Kept state the reattach settled, until the extension's load claims it or the attach finishes. */
const awaitingByProfileId = new Map<string, Map<string, number>>()
/** Profiles an idle unload stopped this run: their reattach resumes extensions, not a startup. */
const idleUnloadedProfileIds = new Set<string>()
/** Profile → extensions reloaded while it was idle; they get onInstalled(update) on reattach. */
const reloadedWhileIdle = new Map<string, Set<string>>()
/** Profile → extensions whose session state could not all be kept; they start clean on reattach. */
const cleanStarts = new Map<string, Set<string>>()
const dropListeners = new Set<(profileId: string, extensionId: string) => void>()

function installTime(extensionId: string): number | undefined {
  return getBrowserExtensionInstallStore().get(extensionId)?.installTime
}

/** Called as an idle unload begins, with the copies running then; later loads start fresh. */
export function beginIdleUnload(
  profileId: string,
  extensions: readonly Pick<Electron.Extension, 'id'>[]
): void {
  idleUnloadedProfileIds.add(profileId)
  const kept = new Map<string, number>()
  for (const { id } of extensions) {
    const time = installTime(id)
    if (time !== undefined) {
      kept.set(id, time)
    }
  }
  if (kept.size > 0) {
    keptByProfileId.set(profileId, kept)
  }
}

/** Before any unload removes a profile's extensions: keep what an idle unload can keep. */
export type BrowserExtensionUnloadingHook = (
  sess: Electron.Session,
  profileId: string,
  extensions: Electron.Extension[]
) => Promise<void>

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
 * Before an attach loads anything: a copy updated, reinstalled or disabled while idle starts fresh.
 * Returns each extension's load kind, since Chrome fires runtime.onStartup only for a profile's
 * first start, when session state is empty.
 */
export function settleKeptStateOnAttach(
  profileId: string,
  enabledExtensionIds: readonly string[]
): (extensionId: string) => BrowserExtensionLoadKind {
  const enabled = new Set(enabledExtensionIds)
  dropKept(keptByProfileId, profileId, (id, time) => !enabled.has(id) || installTime(id) !== time)
  const kept = keptByProfileId.get(profileId)
  keptByProfileId.delete(profileId)
  if (kept) {
    awaitingByProfileId.set(profileId, kept)
  }
  const reloaded = reloadedWhileIdle.get(profileId) ?? new Set<string>()
  const clean = cleanStarts.get(profileId) ?? new Set<string>()
  reloadedWhileIdle.delete(profileId)
  cleanStarts.delete(profileId)
  const resumed = idleUnloadedProfileIds.has(profileId)
  return (extensionId) =>
    reloaded.has(extensionId) ? 'reload' : resumed && !clean.has(extensionId) ? 'other' : 'startup'
}

/**
 * An extension whose session state the idle unload could not all keep (session storage unreadable,
 * or loaded after the unload began): drop the rest so its onStartup rebuilds from a clean start.
 */
export function startBrowserExtensionCleanAfterIdle(profileId: string, extensionId: string): void {
  const clean = cleanStarts.get(profileId) ?? new Set<string>()
  cleanStarts.set(profileId, clean.add(extensionId))
  dropBrowserExtensionIdleState({ profileId, extensionId })
}

/** The reattach loaded the kept copy: its state is live again. */
export function claimBrowserExtensionIdleState(profileId: string, extensionId: string): void {
  const awaiting = awaitingByProfileId.get(profileId)
  awaiting?.delete(extensionId)
  if (awaiting?.size === 0) {
    awaitingByProfileId.delete(profileId)
  }
}

/** The reattach's loads settled: what none claimed failed, was disabled or reloaded meanwhile. */
export function dropUnclaimedBrowserExtensionIdleState(profileId: string): void {
  dropKept(awaitingByProfileId, profileId, () => true)
}

/** Settings reloaded the extension where it runs; profiles stopped or stopping get it on reattach. */
export function noteBrowserExtensionReloadedWhileIdle(
  extensionId: string,
  detachedProfileIds: readonly string[]
): void {
  for (const profileId of detachedProfileIds) {
    if (idleUnloadedProfileIds.has(profileId)) {
      const reloaded = reloadedWhileIdle.get(profileId) ?? new Set<string>()
      reloadedWhileIdle.set(profileId, reloaded.add(extensionId))
    }
  }
  dropBrowserExtensionIdleState({ extensionId })
}

/**
 * Drops kept state: the extension was reloaded or uninstalled, or the profile deleted. `forgetProfile` (profile delete) and an empty scope
 * (extensions turned off, like a browser quit) also forget that the profile went idle.
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
    cleanStarts.clear()
  } else if (profileId !== undefined && scope.forgetProfile) {
    idleUnloadedProfileIds.delete(profileId)
    reloadedWhileIdle.delete(profileId)
    cleanStarts.delete(profileId)
  }
  for (const map of [keptByProfileId, awaitingByProfileId]) {
    for (const id of profileId === undefined ? [...map.keys()] : [profileId]) {
      dropKept(map, id, (kept) => extensionId === undefined || extensionId === kept)
    }
  }
}

function dropKept(
  map: Map<string, Map<string, number>>,
  profileId: string,
  matches: (extensionId: string, time: number) => boolean
): void {
  const kept = map.get(profileId)
  for (const [extensionId, time] of kept ?? []) {
    if (matches(extensionId, time)) {
      kept?.delete(extensionId)
      for (const listener of dropListeners) {
        listener(profileId, extensionId)
      }
    }
  }
  if (kept?.size === 0) {
    map.delete(profileId)
  }
}
