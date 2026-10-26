import { forgetBrowserPasswordVault } from '../../browser-passwords/browser-password-vaults'
import { forgetBrowserSiteDisplay } from '../site-settings/browser-site-display-store'
import { forgetBrowserSitePermissions } from '../site-settings/browser-site-permission-store'

/** Drops everything Orca stores per browser profile outside its Chromium partition. */
export function forgetBrowserProfileOwnedStores(profileId: string): void {
  forgetBrowserSitePermissions(profileId)
  forgetBrowserSiteDisplay(profileId)
  forgetBrowserPasswordVault(profileId)
}
