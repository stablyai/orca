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
  /** One profile's jar on this computer. */
  sessionClearCookies: (args: { profileId: string }) => Promise<boolean>
  /** Null when the environment's pages are not client-hosted on this desktop. */
  sessionClearCookiesForClientHost: (args: {
    environmentId: string
    profileId: string
  }) => Promise<boolean | null>
  /** The jar this SSH host's pages of one profile use on this computer. */
  sessionClearCookiesForSshHost: (args: {
    sshTargetId: string
    profileId: string
  }) => Promise<boolean>
}
