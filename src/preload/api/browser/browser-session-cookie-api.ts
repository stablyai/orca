import type {
  GoogleCookieClearLocalTarget,
  GoogleCookieClearResult
} from '../../../shared/browser/cookies/browser-google-cookie-clear'
import type {
  BrowserClientHostCookieImportArgs,
  BrowserCookieImportResult
} from '../../../shared/browser/workspaces/browser-workspace-types'

export type BrowserSessionCookieApi = {
  /** Null when the environment's pages are not client-hosted on this desktop. */
  sessionImportCookiesForClientHost: (
    args: BrowserClientHostCookieImportArgs
  ) => Promise<BrowserCookieImportResult | null>
  sessionResolvePartition: (args: { profileId: string | null }) => Promise<string | null>
  sessionGoogleCookieClearTarget: (args: {
    profileId: string
    environmentId: string | null
  }) => Promise<GoogleCookieClearLocalTarget | null>
  sessionClearGoogleCookies: (
    target: GoogleCookieClearLocalTarget
  ) => Promise<GoogleCookieClearResult>
  sessionClearDefaultCookies: () => Promise<boolean>
  /** Null when the environment's pages are not client-hosted on this desktop. */
  sessionClearDefaultCookiesForClientHost: (args: {
    environmentId: string
  }) => Promise<boolean | null>
}
