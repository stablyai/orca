import type {
  GoogleCookieClearLocalTarget,
  GoogleCookieClearResult
} from '../../../shared/browser/cookies/browser-google-cookie-clear'
import type { BrowserCookieImportResult } from '../../../shared/browser/workspaces/browser-workspace-types'
import type { BrowserSiteListSetResult } from '../../../shared/browser/profiles/browser-profile-site-list'

export type BrowserSessionCookieApi = {
  /** Null when the environment's pages are not client-hosted on this desktop. */
  sessionImportCookiesForClientHost: (args: {
    environmentId: string
    profileId: string
  }) => Promise<BrowserCookieImportResult | null>
  sessionResolvePartition: (args: { profileId: string | null }) => Promise<string | null>
  sessionGoogleCookieClearTarget: (args: {
    profileId: string
    environmentId: string | null
  }) => Promise<GoogleCookieClearLocalTarget | null>
  sessionClearGoogleCookies: (
    target: GoogleCookieClearLocalTarget
  ) => Promise<GoogleCookieClearResult>
  sessionClearDefaultCookies: () => Promise<boolean>
  sessionGetAllowedHosts: (args: { profileId: string }) => Promise<string[] | null>
  sessionSetAllowedHosts: (args: {
    profileId: string
    hosts: string[]
  }) => Promise<BrowserSiteListSetResult>
}
