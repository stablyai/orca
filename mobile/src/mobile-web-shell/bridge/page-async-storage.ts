import { isPageStorageKeyForHost, PAGE_STORAGE_MAX_VALUE_CHARS } from '../page-storage-keys'

/**
 * The page's AsyncStorage: the app's store, read from `init` and written over the `storage` grant.
 *
 * AsyncStorage's web build is `window.localStorage`, and the page has none worth having — Android
 * turns DOM storage off, and on iOS the origin host is the session id, so every remount starts
 * empty. A pin that silently forgets itself is worse than one that cannot be set, so this holds the
 * app's own values instead: `init` primes them, a write is applied here and posted, and the app is
 * where it lands.
 *
 * Reads are synchronous against that cache behind an async surface, which is what the real module
 * is too. Nothing here waits on the shell: a write the shell drops is a write the next `init`
 * corrects, and a read that waited for a round trip would change what the first render sees.
 */
type PageStorageWriter = (key: string, value: string | null) => boolean

const values = new Map<string, string>()
let write: PageStorageWriter = () => false
/** The host this document was opened for; no key belonging to another one is writable. */
let hostId = ''

/** Called once by the entry, before anything renders, with what `init` carried. */
export function publishPageStorage(
  entries: Readonly<Record<string, string>>,
  writer: PageStorageWriter,
  forHostId: string
): void {
  values.clear()
  for (const [key, value] of Object.entries(entries)) {
    values.set(key, value)
  }
  write = writer
  hostId = forHostId
}

/**
 * Refused rather than kept locally.
 *
 * A key outside the allowlist is one the shell will not write, so holding it here would answer a
 * later read with a value no other screen in the app can see — a pin that looks set and is not,
 * which is exactly the failure the grant exists to avoid.
 */
function accept(key: string, value: string | null): boolean {
  if (!isPageStorageKeyForHost(key, hostId)) {
    return false
  }
  // The envelope's own bound, imported rather than restated: without it an oversized value is
  // cached here and dropped on the wire, so the page reads back a write no other screen can see.
  if (value !== null && value.length > PAGE_STORAGE_MAX_VALUE_CHARS) {
    return false
  }
  if (!write(key, value)) {
    return false
  }
  if (value === null) {
    values.delete(key)
  } else {
    values.set(key, value)
  }
  return true
}

const pageAsyncStorage = {
  getItem: (key: string): Promise<string | null> => Promise.resolve(values.get(key) ?? null),
  setItem: (key: string, value: string): Promise<void> => {
    accept(key, value)
    return Promise.resolve()
  },
  removeItem: (key: string): Promise<void> => {
    accept(key, null)
    return Promise.resolve()
  },
  multiGet: (keys: readonly string[]): Promise<[string, string | null][]> =>
    Promise.resolve(keys.map((key) => [key, values.get(key) ?? null])),
  multiSet: (pairs: readonly [string, string][]): Promise<void> => {
    for (const [key, value] of pairs) {
      accept(key, value)
    }
    return Promise.resolve()
  },
  multiRemove: (keys: readonly string[]): Promise<void> => {
    for (const key of keys) {
      accept(key, null)
    }
    return Promise.resolve()
  },
  getAllKeys: (): Promise<string[]> => Promise.resolve([...values.keys()]),
  // The app's store is not this document's to empty, and no screen in the page closure calls it.
  clear: (): Promise<void> => Promise.resolve()
}

export default pageAsyncStorage
