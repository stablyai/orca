import type { Session } from 'electron'

import {
  compileBrowserSiteList,
  isUrlAllowedBySiteList,
  type CompiledBrowserSiteList
} from '../../../../shared/browser/profiles/browser-profile-site-list'

// Keyed by profile, not session: SSH route partitions of a profile share its list.
const compiledByProfileId = new Map<string, CompiledBrowserSiteList>()
const profileIdBySession = new WeakMap<Session, string>()

/** Replaces every profile's list (startup); an empty or missing list means unrestricted. */
export function replaceBrowserProfileSiteLists(byProfileId: Record<string, string[]>): void {
  compiledByProfileId.clear()
  for (const [profileId, entries] of Object.entries(byProfileId)) {
    setBrowserProfileSiteList(profileId, entries)
  }
}

export function setBrowserProfileSiteList(profileId: string, entries: readonly string[]): void {
  if (entries.length === 0) {
    compiledByProfileId.delete(profileId)
  } else {
    compiledByProfileId.set(profileId, compileBrowserSiteList(entries))
  }
}

export function bindBrowserSessionToSiteListProfile(session: Session, profileId: string): void {
  profileIdBySession.set(session, profileId)
}

export function unbindBrowserSessionFromSiteList(session: Session): void {
  profileIdBySession.delete(session)
}

/** A session with no known profile or list is unrestricted; this never blocks on a failed lookup. */
export function isBrowserSessionRequestOutsideSiteList(session: Session, url: string): boolean {
  const profileId = profileIdBySession.get(session)
  const list = profileId === undefined ? undefined : compiledByProfileId.get(profileId)
  return list !== undefined && !isUrlAllowedBySiteList(list, url)
}
