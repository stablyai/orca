import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import type { BrowserExtensionLoadKind } from './browser-extension-runtime-lifecycle'

/**
 * An idle unload only stops extensions to save memory, so what they set for the session (action
 * badge and icon, side panel options, non-persistent content scripts) waits for the reattach.
 * Profile → extension id → install time of the copy whose state was kept.
 */
const keptByProfileId = new Map<string, Map<string, number>>()
/** Profiles an idle unload stopped this run: their reattach resumes extensions, not a startup. */
const idleUnloadedProfileIds = new Set<string>()
const dropListeners = new Set<(profileId: string, extensionId: string) => void>()

function installTime(extensionId: string): number | undefined {
  return getBrowserExtensionInstallStore().get(extensionId)?.installTime
}

/** Called before an idle unload removes the profile's extensions. */
export function keepBrowserExtensionStateWhileIdle(
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
 * Before an attach loads anything: the same enabled copy keeps its state; one updated, reinstalled,
 * disabled or removed while idle starts fresh. Returns the load kind, since Chrome fires
 * runtime.onStartup only for a profile's first start, when session state is empty.
 */
export function settleKeptStateOnAttach(
  profileId: string,
  enabledExtensionIds: readonly string[]
): BrowserExtensionLoadKind {
  const kept = keptByProfileId.get(profileId)
  keptByProfileId.delete(profileId)
  for (const [extensionId, time] of kept ?? []) {
    if (!enabledExtensionIds.includes(extensionId) || installTime(extensionId) !== time) {
      notifyDropped(profileId, extensionId)
    }
  }
  return idleUnloadedProfileIds.has(profileId) ? 'other' : 'startup'
}

/**
 * Drops kept state: an explicit reload or uninstall of the extension, the extensions setting turned
 * off, or the profile deleted (which also forgets that it went idle).
 */
export function dropBrowserExtensionIdleState(
  scope: { profileId: string; deleted?: boolean } | { extensionId?: string }
): void {
  if ('profileId' in scope) {
    if (scope.deleted) {
      idleUnloadedProfileIds.delete(scope.profileId)
    }
    dropKept(scope.profileId, () => true)
    return
  }
  for (const profileId of keptByProfileId.keys()) {
    dropKept(profileId, (id) => scope.extensionId === undefined || scope.extensionId === id)
  }
}

function dropKept(profileId: string, matches: (extensionId: string) => boolean): void {
  const kept = keptByProfileId.get(profileId)
  for (const extensionId of kept?.keys() ?? []) {
    if (matches(extensionId)) {
      kept?.delete(extensionId)
      notifyDropped(profileId, extensionId)
    }
  }
  if (kept?.size === 0) {
    keptByProfileId.delete(profileId)
  }
}

function notifyDropped(profileId: string, extensionId: string): void {
  for (const listener of dropListeners) {
    listener(profileId, extensionId)
  }
}
