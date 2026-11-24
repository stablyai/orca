import type { WebContents } from 'electron'
import { localBrowserProfileIdForSession } from '../browser/sessions/profiles/browser-session-local-profile'
import type { BrowserPasswordStore } from './browser-password-store'
import { getBrowserPasswordVault } from './browser-password-vaults'

export type BrowserPasswordSettings = {
  offerToSave: boolean
  fillRequiresReauth: boolean
}

const UNCONFIGURED: BrowserPasswordSettings = {
  offerToSave: false,
  fillRequiresReauth: false
}

let readSettings: () => BrowserPasswordSettings = () => UNCONFIGURED

export function setBrowserPasswordSettingsSource(source: () => BrowserPasswordSettings): void {
  readSettings = source
}

export function browserPasswordSettings(): BrowserPasswordSettings {
  return readSettings()
}

export function browserPasswordVaultFor(browserProfileId: string): BrowserPasswordStore {
  return getBrowserPasswordVault(browserProfileId)
}

/** The vault a guest may use right now: a profile-backed session with storage sealed. */
export function browserPasswordVaultForGuest(
  guest: WebContents
): { browserProfileId: string; vault: BrowserPasswordStore } | null {
  const browserProfileId = localBrowserProfileIdForSession(guest.session)
  if (!browserProfileId) {
    return null
  }
  const vault = browserPasswordVaultFor(browserProfileId)
  return vault.availability().available ? { browserProfileId, vault } : null
}
