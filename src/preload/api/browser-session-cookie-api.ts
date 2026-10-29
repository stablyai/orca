import type {
  GoogleCookieClearLocalTarget,
  GoogleCookieClearResult
} from '../../shared/browser-google-cookie-clear'

export type BrowserSessionCookieApi = {
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
