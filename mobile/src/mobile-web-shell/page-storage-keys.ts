/**
 * Which of the app's stored keys the page may read and write, and how much of each.
 *
 * AsyncStorage's web build is `window.localStorage`, which the page does not have: Android turns
 * DOM storage off and on iOS the origin host is the session id, so anything written there is empty
 * again on the next remount. A pin that silently forgets itself is worse than one that cannot be
 * set, so the page's store is the app's, reached over the `storage` grant.
 *
 * An allowlist and not a passthrough. Everything the app keeps under `orca:` is in one namespace —
 * push registrations, the hybrid shell flag itself — and a page that could write any of them could
 * turn the feature on for a build that never offered it. A prefix is listed only where the key
 * carries an id the desktop chooses; the rest are exact.
 */
export const PAGE_STORAGE_EXACT_KEYS = [
  /** The repo the New Workspace drawer opens on. */
  'orca:last-visited-worktree'
] as const

export const PAGE_STORAGE_KEY_PREFIXES = [
  /** `orca:pins:<hostId>`: the pinned worktrees of the host whose list the page is showing. */
  'orca:pins:'
] as const

/** Long enough for a host's pinned ids, and far short of what a quota refuses. */
export const PAGE_STORAGE_MAX_VALUE_CHARS = 16 * 1024
export const PAGE_STORAGE_MAX_KEY_CHARS = 256
/** Every allowlisted key at once, which is what `init` carries. */
export const PAGE_STORAGE_MAX_ENTRIES = 32

export function isPageStorageKey(key: string): boolean {
  if (key.length > PAGE_STORAGE_MAX_KEY_CHARS) {
    return false
  }
  return (
    PAGE_STORAGE_EXACT_KEYS.some((allowed) => allowed === key) ||
    PAGE_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length)
  )
}

/** The keys the shell reads out of the app's store and hands the page in `init`. */
export function pageStorageKeysForHost(hostId: string): string[] {
  return [...PAGE_STORAGE_EXACT_KEYS, `orca:pins:${hostId}`]
}

/**
 * The allowlist narrowed to one host, which is the one every write is actually held to.
 *
 * `isPageStorageKey` answers for the shape, so `orca:pins:<any host>` passes it; a page opened for
 * one host could therefore rewrite another's pinned list, which is not a key it was ever handed.
 * What the page may write is exactly what it was given, so this is that same list.
 */
export function isPageStorageKeyForHost(key: string, hostId: string): boolean {
  return key.length <= PAGE_STORAGE_MAX_KEY_CHARS && pageStorageKeysForHost(hostId).includes(key)
}
