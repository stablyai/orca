import type { Session } from 'electron'

import {
  compileBrowserSiteList,
  isUrlAllowedBySiteList,
  type CompiledBrowserSiteList
} from '../../../../shared/browser/profiles/browser-profile-site-list'

// Keyed by profile, not session: SSH route partitions of a profile share its list.
const listsByProfileId = new Map<string, { entries: string[]; compiled: CompiledBrowserSiteList }>()
const profileIdBySession = new WeakMap<Session, string>()

export function setBrowserProfileSiteList(profileId: string, entries: readonly string[]): void {
  if (entries.length === 0) {
    listsByProfileId.delete(profileId)
  } else {
    listsByProfileId.set(profileId, {
      entries: [...entries],
      compiled: compileBrowserSiteList(entries)
    })
  }
}

export function seedBrowserProfileSiteLists<
  T extends { allowedHostsByProfileId: Record<string, string[]> }
>(meta: T): T {
  for (const [profileId, entries] of Object.entries(meta.allowedHostsByProfileId)) {
    setBrowserProfileSiteList(profileId, entries)
  }
  return meta
}

export function getBrowserProfileSiteListEntries(profileId: string): string[] {
  return [...(listsByProfileId.get(profileId)?.entries ?? [])]
}

export function bindBrowserSessionToSiteListProfile(session: Session, profileId: string): void {
  profileIdBySession.set(session, profileId)
}

export function isBrowserSessionRequestOutsideSiteList(session: Session, url: string): boolean {
  const profileId = profileIdBySession.get(session)
  const list = profileId === undefined ? undefined : listsByProfileId.get(profileId)
  return list !== undefined && !isUrlAllowedBySiteList(list.compiled, url)
}
