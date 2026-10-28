import { session, type Session, type WebContents } from 'electron'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { localSshBrowserProfileIdForSession } from '../browser/local-ssh-browser-partitions'
import type { BrowserPasswordStore } from './browser-password-store'
import { getBrowserPasswordVault } from './browser-password-vaults'

export type BrowserPasswordSettings = {
  enabled: boolean
  offerToSave: boolean
  fillRequiresReauth: boolean
}

const DISABLED: BrowserPasswordSettings = {
  enabled: false,
  offerToSave: false,
  fillRequiresReauth: false
}

let readSettings: () => BrowserPasswordSettings = () => DISABLED

export function setBrowserPasswordSettingsSource(source: () => BrowserPasswordSettings): void {
  readSettings = source
}

export function browserPasswordSettings(): BrowserPasswordSettings {
  return readSettings()
}

/** The browser profile whose vault serves this session, or null for sessions with no vault. */
export function browserPasswordProfileIdForSession(webSession: Session): string | null {
  for (const profile of browserSessionRegistry.listProfiles()) {
    if (webSession === session.fromPartition(profile.partition)) {
      return profile.id
    }
  }
  // SSH-routed pages use a proxied partition that still belongs to one browser profile.
  return localSshBrowserProfileIdForSession(webSession)
}

export function browserPasswordVaultFor(browserProfileId: string): BrowserPasswordStore {
  return getBrowserPasswordVault(browserProfileId)
}

/** The vault a guest may use right now: setting on, a profile-backed session, storage sealed. */
export function browserPasswordVaultForGuest(
  guest: WebContents
): { browserProfileId: string; vault: BrowserPasswordStore } | null {
  if (!readSettings().enabled) {
    return null
  }
  const browserProfileId = browserPasswordProfileIdForSession(guest.session)
  if (!browserProfileId) {
    return null
  }
  const vault = browserPasswordVaultFor(browserProfileId)
  return vault.availability().available ? { browserProfileId, vault } : null
}
