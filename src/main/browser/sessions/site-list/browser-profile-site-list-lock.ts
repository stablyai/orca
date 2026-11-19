import { BrowserError } from '../../browser-error'
import { getBrowserProfileSiteListEntries } from './browser-session-site-list'

export const BROWSER_PROFILE_SITE_LIST_LOCKED_CODE = 'browser_profile_site_list_locked'

const DEFAULT_PROFILE_ID = 'default'

export function browserProfileHasSiteList(profileId: string | null | undefined): boolean {
  return getBrowserProfileSiteListEntries(profileId || DEFAULT_PROFILE_ID).length > 0
}

/** Why a refusal and not a silent no-op: the agent should learn that only the person can lift this. */
export function assertAgentMayLeaveProfile(profileId: string | null | undefined): void {
  if (browserProfileHasSiteList(profileId)) {
    throw new BrowserError(
      BROWSER_PROFILE_SITE_LIST_LOCKED_CODE,
      "This browser profile has a site list, so agents can't move browsing out of it. Change it in Settings > Browser."
    )
  }
}

export function assertAgentMayMoveBrowsingOut(
  fromProfileId: string | null | undefined,
  toProfileId: string | null | undefined
): void {
  if ((fromProfileId || DEFAULT_PROFILE_ID) !== (toProfileId || DEFAULT_PROFILE_ID)) {
    assertAgentMayLeaveProfile(fromProfileId)
  }
}
