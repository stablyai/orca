/**
 * Which of the app's stored keys the page may read and write, and how much of each.
 *
 * AsyncStorage's web build is `window.localStorage`, which the page does not have: Android turns
 * DOM storage off and on iOS the origin host is the session id, so anything written there is empty
 * again on the next remount. A pin that silently forgets itself is worse than one that cannot be
 * set, so the page's store is the app's, reached over the `storage` grant.
 *
 * An allowlist and not a passthrough. Everything the app keeps under `orca:` is in one namespace —
 * paired hosts, push registrations — and a page that could write any of them could rewrite state
 * the native app owns. A prefix is listed only where the key carries an id the desktop chooses; the
 * rest are exact.
 *
 * Every key here was read off a page route's own closure rather than taken from a list: a key a
 * screen reads and this file does not name is a preference that silently falls back to its default
 * inside the page and keeps working outside it, which is the failure the grant exists to end
 * (rulings-ota-c7.md ruling 7).
 */
export const TERMINAL_SHORTCUT_STORAGE_KEYS = [
  'orca:terminal-accessory-layout',
  'orca:custom-accessory-keys'
] as const

export const PAGE_STORAGE_EXACT_KEYS = [
  'orca:last-visited-worktree',
  'orca:hostSidebarWidth',
  'orca:hostDockWidth',
  'orca:terminal-accessory-layout',
  'orca:custom-accessory-keys',
  'orca:defaultSessionView',
  /** Legacy journal access for embedded pages served by older hosts. */
  'orca:mobileStructuredSendOperations:v1',
  'orca:terminalTextScale',
  'orca:terminalAutocompleteEnabled',
  /** Whether a terminal link opens in Orca's browser or the phone's. */
  'orca:terminalLinkOpenMode',
  /** The split terminal's chosen direction. */
  'orca:terminalSplitLayout',
  /** Which usage window the composer meter shows. */
  'orca:composerUsageWindow'
] as const

/**
 * Keys added after pages stopped sharing one allowlist with every host. An older page's `init`
 * reader refines each key against its own list and refuses the whole frame on one it lacks, so
 * the host sends these only to a page whose `ready` named them in `storageKeys`.
 */
export const NEGOTIATED_PAGE_STORAGE_KEYS = [
  'orca:terminalSplitLayout',
  'orca:composerUsageWindow'
] as const

/** Whether a page that declared `storageKeys` (null: declared nothing) reads this key in `init`. */
export function pageReadsStorageKey(key: string, declared: readonly string[] | null): boolean {
  return (
    !NEGOTIATED_PAGE_STORAGE_KEYS.some((negotiated) => negotiated === key) ||
    (declared?.includes(key) ?? false)
  )
}

/** The part of `init` storage the page on the other side can read. */
export function pageStorageForReader(
  held: PageStorageForInit,
  declared: readonly string[] | null
): PageStorageForInit {
  return {
    storage: Object.fromEntries(
      Object.entries(held.storage).filter(([key]) => pageReadsStorageKey(key, declared))
    ),
    storageOversize: held.storageOversize.filter((key) => pageReadsStorageKey(key, declared))
  }
}

export const PAGE_STORAGE_KEY_PREFIXES = [
  'orca:pins:',
  'orca:nativeChatTabs:',
  'orca:terminalLiveInputDisabled:',
  'orca:terminalDrafts:'
] as const

export const PAGE_STORAGE_MAX_VALUE_CHARS = 16 * 1024
export const PAGE_STORAGE_MAX_KEY_CHARS = 256
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

// Derive workspace scope from the pathname both endpoints receive; only session routes currently own workspace keys.
export function pageRouteWorkspace(
  pathname: string
): { hostId: string; worktreeId: string } | null {
  const segments = pathname.split('/')
  if (segments.length !== 5 || segments[0] !== '' || segments[1] !== 'h') {
    return null
  }
  if (segments[3] !== 'session') {
    return null
  }
  try {
    const hostId = decodeURIComponent(segments[2] ?? '')
    const worktreeId = decodeURIComponent(segments[4] ?? '')
    return hostId === '' || worktreeId === '' ? null : { hostId, worktreeId }
  } catch {
    // Malformed escapes must yield no workspace key, never a key constructed from invalid route text.
    return null
  }
}

const WORKSPACE_KEY_PREFIXES = [
  'orca:nativeChatTabs:',
  'orca:terminalLiveInputDisabled:',
  'orca:terminalDrafts:'
] as const

function workspaceScopedKey(prefix: string, hostId: string, worktreeId: string): string {
  return `${prefix}${encodeURIComponent(hostId)}:${encodeURIComponent(worktreeId)}`
}

// Host-area pages may access any workspace here; encoded host ids contain no colon, preventing cross-host prefix matches.
export function isHostWorkspaceStorageKey(key: string, hostId: string): boolean {
  const scope = `${encodeURIComponent(hostId)}:`
  return (
    isPageStorageKey(key) &&
    WORKSPACE_KEY_PREFIXES.some(
      (prefix) => key.startsWith(prefix + scope) && key.length > prefix.length + scope.length
    )
  )
}

// Filter generated keys through the page’s schema bounds: an overlong workspace id must not reject the whole init frame.
export function pageStorageKeysForRoute(hostId: string, routePathname: string): string[] {
  const workspace = pageRouteWorkspace(routePathname)
  const scoped =
    workspace === null || workspace.hostId !== hostId
      ? []
      : WORKSPACE_KEY_PREFIXES.map((prefix) =>
          workspaceScopedKey(prefix, hostId, workspace.worktreeId)
        )
  return [...PAGE_STORAGE_EXACT_KEYS, `orca:pins:${hostId}`, ...scoped].filter(isPageStorageKey)
}

// Narrow key shapes to this host/workspace; host-area pages additionally reach this host’s other workspaces.
export function isPageStorageKeyForRoute(
  key: string,
  hostId: string,
  routePathname: string,
  hostArea = false
): boolean {
  return (
    key.length <= PAGE_STORAGE_MAX_KEY_CHARS &&
    (pageStorageKeysForRoute(hostId, routePathname).includes(key) ||
      (hostArea && isHostWorkspaceStorageKey(key, hostId)))
  )
}

// Refuse writes to oversized values omitted from init, including from old pages that ignore storageOversize; otherwise default data could overwrite the native journal (ruling 33.6).
export function pageMayWriteStorageKey(
  key: string,
  hostId: string,
  route: { pathname: string } | null,
  held: PageStorageForInit,
  hostArea = false
): boolean {
  return (
    route !== null &&
    isPageStorageKeyForRoute(key, hostId, route.pathname, hostArea) &&
    !held.storageOversize.includes(key)
  )
}

export type PageStorageForInit = {
  storage: Readonly<Record<string, string>>
  storageOversize: readonly string[]
}

// Omit oversized values so one large journal cannot reject all of init; report value-cap drops as unwritable to prevent empty page state overwriting native operation ids.
// Entry-cap drops remain writable because their values fit; only missing oversized contents make replacement destructive.
export function pageStorageEntriesForInit(held: Readonly<Record<string, string>>): {
  entries: Record<string, string>
  dropped: string[]
  oversize: string[]
} {
  const entries: Record<string, string> = {}
  const dropped: string[] = []
  const oversize: string[] = []
  for (const [key, value] of Object.entries(held)) {
    if (value.length > PAGE_STORAGE_MAX_VALUE_CHARS) {
      dropped.push(key)
      oversize.push(key)
      continue
    }
    if (Object.keys(entries).length >= PAGE_STORAGE_MAX_ENTRIES) {
      dropped.push(key)
      continue
    }
    entries[key] = value
  }
  return { entries, dropped, oversize }
}
