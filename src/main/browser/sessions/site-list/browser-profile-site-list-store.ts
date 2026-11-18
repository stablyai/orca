import { browserSessionRegistry } from '../profiles/browser-session-registry'
import {
  persistBrowserSessionMeta,
  readBrowserSessionMeta
} from '../profiles/browser-session-meta-store'
import { setBrowserProfileSiteList } from './browser-session-site-list'

const metadataPath = (): string => browserSessionRegistry.metadataPath
const readMeta = (): ReturnType<typeof readBrowserSessionMeta> =>
  readBrowserSessionMeta(metadataPath, browserSessionRegistry.defaultPartition)

let loaded = false

// Unreadable file: nothing is enforced and edits are refused, so it is never rewritten.
export function loadBrowserProfileSiteLists(): boolean {
  const meta = readMeta() ?? readMeta()
  loaded = meta !== null
  for (const [profileId, entries] of Object.entries(meta?.allowedHostsByProfileId ?? {})) {
    setBrowserProfileSiteList(profileId, entries)
  }
  return loaded
}

export function ensureBrowserProfileSiteListsLoaded(): boolean {
  return loaded || loadBrowserProfileSiteLists()
}

export function saveBrowserProfileSiteList(profileId: string, entries: string[]): boolean {
  const meta = readMeta()
  if (!meta) {
    return false
  }
  const lists = { ...meta.allowedHostsByProfileId }
  delete lists[profileId]
  if (entries.length > 0) {
    lists[profileId] = entries
  }
  const saved = persistBrowserSessionMeta(metadataPath, browserSessionRegistry.defaultPartition, {
    allowedHostsByProfileId: lists
  })
  if (saved) {
    setBrowserProfileSiteList(profileId, entries)
  }
  return saved
}
