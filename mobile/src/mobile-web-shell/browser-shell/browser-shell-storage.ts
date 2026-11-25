import {
  PAGE_STORAGE_MAX_ENTRIES,
  PAGE_STORAGE_MAX_VALUE_CHARS,
  pageStorageKeysForRoute,
  type PageStorageForInit
} from '../page-storage/page-storage-keys'

// Shares an origin with the desktop web client, so page keys live under a prefix of their own.
const PAGE_KEY_PREFIX = 'orca.mobileWeb.page.'

/** The browser's stand-in for the app's page-storage journal: the bridge host already checks every key. */
export type BrowserShellStorage = {
  readForInit: (hostId: string, routePathname: string) => PageStorageForInit
  read: (key: string) => string | null
  write: (key: string, value: string | null) => void
}

export function createBrowserShellStorage(store: Storage | null): BrowserShellStorage {
  const read = (key: string): string | null => {
    try {
      return store?.getItem(PAGE_KEY_PREFIX + key) ?? null
    } catch {
      return null
    }
  }
  return {
    readForInit: (hostId, routePathname) => {
      const storage: Record<string, string> = {}
      const storageOversize: string[] = []
      for (const key of pageStorageKeysForRoute(hostId, routePathname).slice(
        0,
        PAGE_STORAGE_MAX_ENTRIES
      )) {
        const value = read(key)
        if (value === null) {
          continue
        }
        if (value.length > PAGE_STORAGE_MAX_VALUE_CHARS) {
          storageOversize.push(key)
        } else {
          storage[key] = value
        }
      }
      return { storage, storageOversize }
    },
    read,
    write: (key, value) => {
      try {
        if (value === null) {
          store?.removeItem(PAGE_KEY_PREFIX + key)
        } else {
          store?.setItem(PAGE_KEY_PREFIX + key, value)
        }
      } catch {
        // A full or refused store loses this write, as a dropped bridge write would.
      }
    }
  }
}
