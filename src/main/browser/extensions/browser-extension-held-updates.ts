import type { BrowserExtensionAccessLists } from '../../../shared/browser-extension-permission-warnings'
import { notifyBrowserExtensionListChanged } from './browser-extension-list-changes'

/** A store update that would show new install warnings, kept until the user reviews it in Settings. */
export type HeldBrowserExtensionUpdate = {
  version: string
  url: string
  sha256: string | undefined
  size: number | undefined
  /** The held version's whole access; the package downloaded on approval must match it. */
  access: BrowserExtensionAccessLists
  /** Only the access whose warnings the installed version does not already show. */
  newWarnings: BrowserExtensionAccessLists
}

// Why memory only: the updater re-finds a held update a minute after every launch.
const held = new Map<string, HeldBrowserExtensionUpdate>()

export function holdBrowserExtensionUpdate(
  extensionId: string,
  update: HeldBrowserExtensionUpdate
): void {
  held.set(extensionId, update)
  notifyBrowserExtensionListChanged()
}

export function getHeldBrowserExtensionUpdate(
  extensionId: string
): HeldBrowserExtensionUpdate | null {
  return held.get(extensionId) ?? null
}

export function forgetHeldBrowserExtensionUpdate(extensionId: string): void {
  if (held.delete(extensionId)) {
    notifyBrowserExtensionListChanged()
  }
}
