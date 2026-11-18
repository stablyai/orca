import { browserSessionRegistry } from '../profiles/browser-session-registry'
import {
  loadBrowserSessionMeta,
  persistBrowserSessionMeta
} from '../profiles/browser-session-meta-store'
import {
  getAllBrowserProfileSiteLists,
  replaceBrowserProfileSiteLists,
  setBrowserProfileSiteList
} from './browser-session-site-list'

const metadataPath = (): string => browserSessionRegistry.metadataPath

/** Startup: enforce the saved lists. Must run before any profile session binds to its profile. */
export function loadPersistedBrowserProfileSiteLists(): void {
  const meta = loadBrowserSessionMeta(metadataPath, browserSessionRegistry.defaultPartition)
  replaceBrowserProfileSiteLists(meta.allowedHostsByProfileId)
}

/**
 * Writes the list to disk first and applies it in memory only if that write worked, so memory
 * and disk never disagree about what is enforced. Returns false when nothing changed.
 */
export function saveBrowserProfileSiteList(profileId: string, entries: string[]): boolean {
  const next: Record<string, string[]> = {}
  for (const [id, list] of Object.entries(getAllBrowserProfileSiteLists())) {
    // Lists of deleted profiles are dropped here, matching what deleting a profile does on disk.
    if (id !== profileId && browserSessionRegistry.getProfile(id)) {
      next[id] = list
    }
  }
  if (entries.length > 0) {
    next[profileId] = entries
  }
  const saved = persistBrowserSessionMeta(metadataPath, browserSessionRegistry.defaultPartition, {
    allowedHostsByProfileId: next
  })
  if (saved) {
    setBrowserProfileSiteList(profileId, entries)
  }
  return saved
}
