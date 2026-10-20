import { getBrowserExtensionProfileIdForSession } from './browser-extension-api-host'
import { forgetActionIconCache } from './browser-extension-action-icon'
import {
  BrowserExtensionActionState,
  readManifestActionDefaults
} from './browser-extension-action-state'

/**
 * Orca owns chrome.action state: Electron's built-in action methods keep nothing main can read,
 * so the action namespace overrides all of them and every toolbar reads from here.
 */
const stateByProfileId = new Map<string, Map<string, BrowserExtensionActionState>>()
const observedSessions = new WeakSet<Electron.Session>()
const listeners = new Set<(profileId: string) => void>()

export function onBrowserExtensionActionsChanged(
  listener: (profileId: string) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyBrowserExtensionActionsChanged(profileId: string): void {
  for (const listener of listeners) {
    listener(profileId)
  }
}

/** Loading, enabling or removing an extension changes which buttons a profile's toolbar shows. */
export function observeBrowserExtensionActionSession(sess: Electron.Session): void {
  if (observedSessions.has(sess)) {
    return
  }
  observedSessions.add(sess)
  const changed = (): void => {
    const profileId = getBrowserExtensionProfileIdForSession(sess)
    if (profileId) {
      notifyBrowserExtensionActionsChanged(profileId)
    }
  }
  sess.extensions.on('extension-ready', changed)
  sess.extensions.on('extension-unloaded', (_event, extension) => {
    const profileId = getBrowserExtensionProfileIdForSession(sess)
    stateByProfileId.get(profileId ?? '')?.delete(extension.id)
    forgetActionIconCache(extension.path)
    changed()
  })
}

export function getBrowserExtensionActionState(
  profileId: string,
  extension: Electron.Extension
): BrowserExtensionActionState {
  let byExtension = stateByProfileId.get(profileId)
  if (!byExtension) {
    byExtension = new Map()
    stateByProfileId.set(profileId, byExtension)
  }
  let state = byExtension.get(extension.id)
  if (!state) {
    state = new BrowserExtensionActionState(
      readManifestActionDefaults(extension.manifest, extension.name)
    )
    byExtension.set(extension.id, state)
  }
  return state
}

/** A tab's action overrides end when it loads a new document or closes (Chrome semantics). */
export function forgetBrowserExtensionActionTab(profileId: string, tabId: number): void {
  let changed = false
  for (const state of stateByProfileId.get(profileId)?.values() ?? []) {
    changed = state.forgetTab(tabId) || changed
  }
  if (changed) {
    notifyBrowserExtensionActionsChanged(profileId)
  }
}
