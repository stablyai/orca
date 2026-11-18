import type { Session } from 'electron'

import {
  compileBrowserSiteList,
  isUrlAllowedBySiteList,
  type CompiledBrowserSiteList
} from '../../../../shared/browser/profiles/browser-profile-site-list'

// Keyed by profile, not session: SSH route partitions of a profile share its list.
// This in-memory state is what the request guard enforces and what edits compare against.
const entriesByProfileId = new Map<string, string[]>()
const compiledByProfileId = new Map<string, CompiledBrowserSiteList>()
const profileIdBySession = new WeakMap<Session, string>()

/** Replaces every profile's list (startup); an empty or missing list means unrestricted. */
export function replaceBrowserProfileSiteLists(byProfileId: Record<string, string[]>): void {
  entriesByProfileId.clear()
  compiledByProfileId.clear()
  for (const [profileId, entries] of Object.entries(byProfileId)) {
    setBrowserProfileSiteList(profileId, entries)
  }
}

export function setBrowserProfileSiteList(profileId: string, entries: readonly string[]): void {
  if (entries.length === 0) {
    entriesByProfileId.delete(profileId)
    compiledByProfileId.delete(profileId)
  } else {
    entriesByProfileId.set(profileId, [...entries])
    compiledByProfileId.set(profileId, compileBrowserSiteList(entries))
  }
}

/** The list being enforced right now (empty means unrestricted). */
export function getBrowserProfileSiteListEntries(profileId: string): string[] {
  return [...(entriesByProfileId.get(profileId) ?? [])]
}

export function getAllBrowserProfileSiteLists(): Record<string, string[]> {
  return Object.fromEntries([...entriesByProfileId].map(([id, entries]) => [id, [...entries]]))
}

export function bindBrowserSessionToSiteListProfile(session: Session, profileId: string): void {
  profileIdBySession.set(session, profileId)
}

export function unbindBrowserSessionFromSiteList(session: Session): void {
  profileIdBySession.delete(session)
}

/** A session with no known profile or list is unrestricted; a failed lookup never blocks. */
export function isBrowserSessionRequestOutsideSiteList(session: Session, url: string): boolean {
  const profileId = profileIdBySession.get(session)
  const list = profileId === undefined ? undefined : compiledByProfileId.get(profileId)
  return list !== undefined && !isUrlAllowedBySiteList(list, url)
}
