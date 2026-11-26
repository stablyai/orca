import { forgetBrowserPasswordVault } from '../../../browser-passwords/browser-password-vaults'
import { forgetBrowserSiteDisplay } from '../../site-settings/display/browser-site-display-store'
import { forgetBrowserSitePermissions } from '../../site-settings/permissions/browser-site-permission-store'
import { forgetBrowserSessionCookies } from '../../cookies/session-restore/browser-session-cookie-route-restore'
import { setBrowserProfileSiteList } from '../site-list/browser-session-site-list'

/** Drops everything Orca stores per browser profile outside its Chromium partition. */
export function forgetBrowserProfileOwnedStores(profileId: string): boolean {
  // Why the vault first, and false keeps the profile: once the profile is gone nothing could retry it.
  if (!forgetBrowserPasswordVault(profileId)) {
    return false
  }
  forgetBrowserSitePermissions(profileId)
  forgetBrowserSiteDisplay(profileId)
  forgetBrowserSessionCookies(profileId)
  // The file's copy goes with the meta update; this one keeps a later profile from inheriting it.
  setBrowserProfileSiteList(profileId, [])
  return true
}
