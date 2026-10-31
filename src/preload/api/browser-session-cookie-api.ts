import type {
  GoogleCookieClearLocalTarget,
  GoogleCookieClearResult
} from '../../shared/browser-google-cookie-clear'
import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'

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
}
