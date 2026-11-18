import { browserSessionRegistry } from '../profiles/browser-session-registry'
import {
  readBrowserSessionMetaAsync,
  updateBrowserSessionMetaAsync
} from '../profiles/browser-session-meta-store'
import { seedBrowserProfileSiteLists, setBrowserProfileSiteList } from './browser-session-site-list'

let seeded = false

// Startup seeds the in-memory lists with the rest of the metadata. Here the file is read again: an
// unreadable file means edits are refused (it is never rewritten), and a first good read fills in
// lists that startup could not load.
export async function ensureBrowserProfileSiteListsLoaded(): Promise<boolean> {
  const meta = await readBrowserSessionMetaAsync(
    browserSessionRegistry.metadataPath,
    browserSessionRegistry.defaultPartition
  )
  if (!meta) {
    return false
  }
  if (!seeded) {
    seeded = true
    seedBrowserProfileSiteLists(meta)
  }
  return true
}

export async function saveBrowserProfileSiteList(
  profileId: string,
  entries: string[]
): Promise<boolean> {
  const saved = await updateBrowserSessionMetaAsync(
    browserSessionRegistry.metadataPath,
    browserSessionRegistry.defaultPartition,
    (meta) => {
      const lists = { ...meta.allowedHostsByProfileId }
      delete lists[profileId]
      if (entries.length > 0) {
        lists[profileId] = entries
      }
      return { allowedHostsByProfileId: lists }
    }
  )
  if (saved) {
    setBrowserProfileSiteList(profileId, entries)
  }
  return saved
}
