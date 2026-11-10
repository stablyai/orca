import { forgetBrowserPasswordVault } from '../../../browser-passwords/browser-password-vaults'
import { forgetBrowserSiteDisplay } from '../../site-settings/display/browser-site-display-store'
import { forgetBrowserSitePermissions } from '../../site-settings/permissions/browser-site-permission-store'

/** Drops everything Orca stores per browser profile outside its Chromium partition. */
export function forgetBrowserProfileOwnedStores(profileId: string): boolean {
  // Why the vault first, and false keeps the profile: once the profile is gone nothing could retry it.
  if (!forgetBrowserPasswordVault(profileId)) {
    return false
  }
  forgetBrowserSitePermissions(profileId)
  forgetBrowserSiteDisplay(profileId)
  return true
}
