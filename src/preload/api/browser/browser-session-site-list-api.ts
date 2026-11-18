import type { BrowserSiteListSetResult } from '../../../shared/browser/profiles/browser-profile-site-list-ipc'

export type BrowserSessionSiteListApi = {
  /** The profile's enforced site list; empty means unrestricted. */
  sessionGetAllowedHosts: (args: { profileId: string }) => Promise<string[]>
  /** Confirms widening in a main-process dialog; applied only after it was written to disk. */
  sessionSetAllowedHosts: (args: {
    profileId: string
    hosts: string[]
  }) => Promise<BrowserSiteListSetResult>
}
