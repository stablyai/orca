/**
 * An idle unload only stops extensions to save memory, so what they set for the session (action
 * badge and icon, side panel options, non-persistent content scripts) waits for the reattach.
 * Profile → extension id → the version whose state was kept.
 */
const keptByProfileId = new Map<string, Map<string, string>>()
const dropListeners = new Set<(profileId: string, extensionId: string) => void>()

/** Called before an idle unload removes the profile's extensions. */
export function keepBrowserExtensionStateWhileIdle(
  profileId: string,
  extensions: readonly Pick<Electron.Extension, 'id' | 'version'>[]
): void {
  if (extensions.length > 0) {
    keptByProfileId.set(profileId, new Map(extensions.map((e) => [e.id, e.version])))
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

/** A reattach loaded the extension: same version keeps its state, as an update resets it. */
export function settleBrowserExtensionIdleState(
  profileId: string,
  extension: Electron.Extension
): void {
  const kept = keptByProfileId.get(profileId)
  const version = kept?.get(extension.id)
  if (version === undefined) {
    return
  }
  removeKept(profileId, extension.id)
  if (version !== extension.version) {
    notifyDropped(profileId, extension.id)
  }
}

/**
 * Drops kept state that no load claimed: the reattach finished without it (disabled or removed
 * meanwhile), the extension was uninstalled, or the profile deleted.
 */
export function dropBrowserExtensionIdleState(scope: {
  profileId?: string
  extensionId?: string
}): void {
  for (const [profileId, kept] of keptByProfileId) {
    if (scope.profileId !== undefined && scope.profileId !== profileId) {
      continue
    }
    for (const extensionId of kept.keys()) {
      if (scope.extensionId === undefined || scope.extensionId === extensionId) {
        removeKept(profileId, extensionId)
        notifyDropped(profileId, extensionId)
      }
    }
  }
}

function removeKept(profileId: string, extensionId: string): void {
  const kept = keptByProfileId.get(profileId)
  kept?.delete(extensionId)
  if (kept?.size === 0) {
    keptByProfileId.delete(profileId)
  }
}

function notifyDropped(profileId: string, extensionId: string): void {
  for (const listener of dropListeners) {
    listener(profileId, extensionId)
  }
}
