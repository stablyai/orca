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

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000]

/** Keeps trying, backing off, until the lists load, so a file that becomes readable later applies without anyone opening Settings. */
export function loadBrowserProfileSiteListsWithRetry(attempt = 0): void {
  const retry = (): void => {
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
    setTimeout(() => loadBrowserProfileSiteListsWithRetry(attempt + 1), delay).unref?.()
  }
  ensureBrowserProfileSiteListsLoaded().then(
    (loaded) => {
      if (!loaded) {
        retry()
      }
    },
    (error: unknown) => {
      console.warn('[browser] site lists could not be loaded:', error)
      retry()
    }
  )
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
